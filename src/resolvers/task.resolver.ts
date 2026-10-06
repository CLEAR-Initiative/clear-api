/**
 * Tasks and Workers (ADR-0010).
 *
 * One generic Task table with a row-level lease, exposed as a Worker
 * protocol over GraphQL: request (the trigger), claim (atomic, leased,
 * `FOR UPDATE SKIP LOCKED`), heartbeat, complete, fail, cancel. Postgres is
 * the broker; GraphQL is the only door; clear-api is the only writer of its
 * database. The first kind of work is `event.impact_prior`, whose typed
 * result is an ImpactPrior row beside the Event (supersede, never
 * overwrite); the raw Worker output stays on the Task for audit.
 *
 * Guards: a requester needs the same rights as `escalateEvent`
 * (`requireTeamContentWriter`); claim / heartbeat / complete / fail need the
 * narrow `worker` role and, after claim, the lease on that Task. Reads use
 * the content-reader gate the Event itself uses.
 */

import { GraphQLError } from "graphql";
import { Prisma } from "../generated/prisma/client.js";
import type { Context } from "../context.js";
import {
  isPlatformAdmin,
  requireAuth,
  requireContentReader,
  requireRole,
  requireTeamContentWriter,
} from "../utils/auth-guard.js";
import { env } from "../utils/env.js";
import { logActivity } from "../utils/activity-log.js";
import { notifyTaskOutcome } from "../services/task-notifications.js";

export const IMPACT_PRIOR_KIND = "event.impact_prior";
const EVENT_SUBJECT = "event";
const DEFAULT_HORIZON_YEARS = 10;
const WORKER_ROLE = "worker";
const DECIDER_ROLES = ["admin", "analyst"];
const MAX_RATIONALE_LENGTH = 4000;
/** A Worker's error is stored and emailed; cap it so neither bloats. */
const MAX_ERROR_LENGTH = 2000;

type TaskRow = Prisma.taskGetPayload<Record<string, never>>;
type ImpactPriorRow = Prisma.impactPriorGetPayload<Record<string, never>>;

interface TaskUsageInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface ImpactPriorInput {
  hazardType: string;
  countryLocationId: string;
  geographicScope: string;
  horizonYears: number;
  populationGroup?: string | null;
  metric?: string | null;
  lowerBound?: number | null;
  upperBound?: number | null;
  numberOfCases: number;
  basis: Prisma.InputJsonValue;
  validFrom?: Date | null;
  validTo?: Date | null;
  methodVersion: string;
}

/** Start of the current UTC day — the window the per-requester cap counts
 *  over (same anchor as the daily Agent budget). */
function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const GEOGRAPHIC_SCOPES: ReadonlySet<string> = new Set(["district", "country"]);

/**
 * The level-0 (country) ancestor of an Event's primary location — the
 * location → origin → destination preference `escalateEvent` uses — walking
 * `ancestorIds` the way `resolveEmailLocation` does. Events have no country
 * column. Null when the Event has no location or the walk finds no level 0.
 */
async function resolveEventCountryId(
  prisma: Prisma.TransactionClient | Context["prisma"],
  event: { locationId: string | null; originId: string | null; destinationId: string | null },
): Promise<string | null> {
  const primaryId = event.locationId ?? event.originId ?? event.destinationId;
  if (!primaryId) return null;
  const primary = await prisma.locations.findUnique({
    where: { id: primaryId },
    select: { id: true, level: true, ancestorIds: true },
  });
  if (!primary) return null;
  if (primary.level === 0) return primary.id;
  if (primary.ancestorIds.length === 0) return null;
  const country = await prisma.locations.findFirst({
    where: { id: { in: primary.ancestorIds }, level: 0 },
    select: { id: true },
  });
  return country?.id ?? null;
}

/** Usage as a Worker reports it, validated like recordConversationTurnUsage:
 *  non-negative integer token counts, a finite non-negative cost. */
function validateUsage(usage: TaskUsageInput): TaskUsageInput {
  const model = usage.model?.trim();
  if (!model) throw badInput("usage.model is required");
  for (const [name, value] of Object.entries({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw badInput(`usage.${name} must be a non-negative integer`);
    }
  }
  if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
    throw badInput("usage.costUsd must be a non-negative number");
  }
  return { ...usage, model };
}

/** Shape checks on an ImpactPrior proposal that need no database. */
function validateImpactPriorShape(input: ImpactPriorInput): void {
  if (!GEOGRAPHIC_SCOPES.has(input.geographicScope)) {
    throw badInput('impactPrior.geographicScope must be "district" or "country"');
  }
  if (!Number.isInteger(input.horizonYears) || input.horizonYears <= 0) {
    throw badInput("impactPrior.horizonYears must be a positive integer");
  }
  if (!Number.isInteger(input.numberOfCases) || input.numberOfCases < 1) {
    throw badInput("impactPrior.numberOfCases must be at least 1; omit impactPrior to record no_prior_found");
  }
  if (!Array.isArray(input.basis) || input.basis.length !== input.numberOfCases) {
    throw badInput("impactPrior.basis must list exactly one entry per case");
  }
  if (!input.methodVersion?.trim()) throw badInput("impactPrior.methodVersion is required");
  if (input.validFrom && input.validTo && input.validTo < input.validFrom) {
    throw badInput("impactPrior.validTo must not precede validFrom");
  }
}

const notFound = (what: string) =>
  new GraphQLError(`${what} not found`, { extensions: { code: "NOT_FOUND" } });
const forbidden = (message: string, subCode?: string) =>
  new GraphQLError(message, {
    extensions: subCode ? { code: "FORBIDDEN", subCode } : { code: "FORBIDDEN" },
  });
const conflict = (message: string, subCode?: string) =>
  new GraphQLError(message, {
    extensions: subCode ? { code: "CONFLICT", subCode } : { code: "CONFLICT" },
  });
const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

/** The error a Worker gets when it does not hold the lease: `NOT_LEASED`
 *  (CONFLICT) when the Task is in any other state, `NOT_LEASE_OWNER`
 *  (FORBIDDEN) when another Worker holds it — usually because this one's
 *  lease lapsed and was reclaimed. */
function leaseError(task: TaskRow | null, userId: string, leaseToken: string): GraphQLError {
  if (!task) return notFound("Task");
  if (task.status !== "LEASED") {
    return conflict(`Task is ${task.status}, not LEASED`, "NOT_LEASED");
  }
  if (task.leaseOwnerId !== userId) {
    return forbidden("You do not hold the lease on this Task", "NOT_LEASE_OWNER");
  }
  if (task.leaseToken !== leaseToken) {
    return forbidden(
      "Your lease on this Task lapsed and was reclaimed; this leaseToken is stale",
      "NOT_LEASE_OWNER",
    );
  }
  return conflict("Task changed while writing; retry", "NOT_LEASED");
}

/**
 * The Worker-side ownership check shared by heartbeat / complete / fail:
 * the caller holds the `worker` role, the Task exists, is LEASED, the lease
 * is the caller's AND the caller presents the token that claim minted. The
 * token is what tells two runs of the same Worker identity apart: one
 * service user may be several processes (an overlapping routine run,
 * Dagster replicas), and only the run that holds the current lease may
 * write. A fast pre-check only — the write itself goes through
 * {@link writeAsLeaseOwner}, which re-asserts all of it atomically.
 */
async function requireLeaseOwner(context: Context, id: string, leaseToken: string): Promise<TaskRow> {
  const user = requireRole(context, [WORKER_ROLE]);
  const task = await context.prisma.task.findUnique({ where: { id } });
  if (
    !task ||
    task.status !== "LEASED" ||
    task.leaseOwnerId !== user.id ||
    task.leaseToken !== leaseToken
  ) {
    throw leaseError(task, user.id, leaseToken);
  }
  return task;
}

/**
 * Finish a cancellation the requester or an admin asked for while the Task
 * was LEASED: the Worker's next heartbeat, complete or fail lands here and
 * the Task becomes CANCELLED (its result, if any, discarded). The Worker
 * reads the status and stops.
 */
async function cancelLeasedTask(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
  leaseToken: string,
): Promise<TaskRow> {
  await tx.task.updateMany({
    where: { id, status: "LEASED", leaseOwnerId: userId, leaseToken },
    data: { status: "CANCELLED", leaseExpiresAt: null },
  });
  return tx.task.findUniqueOrThrow({ where: { id } });
}

/**
 * Write to a Task only if it is STILL leased by the caller and no
 * cancellation is pending, in one statement. Between the pre-check and the
 * write a lapsed lease may have been reclaimed by another Worker (a plain
 * `update` by id would overwrite the new owner's lease) or a cancel may
 * have landed (the write must not bury it). On a miss, re-read: a pending
 * cancel is carried out, anything else throws the error the state warrants.
 */
async function writeAsLeaseOwner(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
  leaseToken: string,
  data: Prisma.taskUpdateManyMutationInput,
): Promise<TaskRow> {
  const { count } = await tx.task.updateMany({
    where: { id, status: "LEASED", leaseOwnerId: userId, leaseToken, cancelRequestedAt: null },
    data,
  });
  if (count === 0) {
    const current = await tx.task.findUnique({ where: { id } });
    if (
      current &&
      current.status === "LEASED" &&
      current.leaseOwnerId === userId &&
      current.leaseToken === leaseToken &&
      current.cancelRequestedAt
    ) {
      return cancelLeasedTask(tx, id, userId, leaseToken);
    }
    throw leaseError(current, userId, leaseToken);
  }
  return tx.task.findUniqueOrThrow({ where: { id } });
}

/** The caller as a viewer. Field resolvers run only under a parent read
 *  that already passed requireContentReader, so a missing user is treated
 *  as the most restricted viewer rather than an error. */
function viewerOf(context: Context): { id: string; role?: string | null } {
  return context.user ?? { id: "", role: null };
}

/** `lastError` is the requester's and platform admins' to see; everyone
 *  else gets the Task with it blanked (the `ownView` pattern of
 *  `requestAnalysis`). Applied on every path a Task leaves the resolver
 *  by: the reads, the dedupe return, and the ImpactPrior.task field. */
function redactForViewer<T extends { requesterId: string | null; lastError: string | null }>(
  row: T,
  user: { id: string; role?: string | null },
): T {
  if (isPlatformAdmin(user) || row.requesterId === user.id) return row;
  return { ...row, lastError: null };
}

/** Who may decide a proposed ImpactPrior: platform admins and analysts. */
function isDecider(user: { role?: string | null }): boolean {
  return isPlatformAdmin(user) || user.role === "analyst";
}

/**
 * Visibility of ImpactPriors (decision 15): an `accepted` one follows the
 * Event's visibility (any content reader); a `proposed` one is visible to
 * its requester and to those who may decide it; a `rejected` one stays as
 * superseded history, visible to deciders only.
 */
function visibleImpactPriors<T extends ImpactPriorRow & { task: { requesterId: string | null } }>(
  rows: T[],
  user: { id: string; role?: string | null },
): ImpactPriorRow[] {
  const decider = isDecider(user);
  return rows
    .filter(
      (r) =>
        decider ||
        r.state === "accepted" ||
        (r.state === "proposed" && r.task.requesterId === user.id),
    )
    .map(({ task: _task, ...rest }) => rest);
}

export const taskResolvers = {
  Task: {
    // The token is the lease owner's secret: null for everyone else, so a
    // reader of eventTasks cannot write as the Worker.
    leaseToken: (parent: TaskRow, _args: unknown, context: Context) =>
      parent.leaseToken && context.user?.id === parent.leaseOwnerId ? parent.leaseToken : null,
    requester: (parent: TaskRow, _args: unknown, context: Context) =>
      parent.requesterId
        ? context.prisma.user.findUnique({ where: { id: parent.requesterId } })
        : null,
    leaseOwner: (parent: TaskRow, _args: unknown, context: Context) =>
      parent.leaseOwnerId
        ? context.prisma.user.findUnique({ where: { id: parent.leaseOwnerId } })
        : null,
  },

  ImpactPrior: {
    event: (parent: ImpactPriorRow, _args: unknown, context: Context) =>
      context.prisma.events.findUniqueOrThrow({ where: { id: parent.eventId } }),
    task: async (parent: ImpactPriorRow, _args: unknown, context: Context) =>
      redactForViewer(
        await context.prisma.task.findUniqueOrThrow({ where: { id: parent.taskId } }),
        viewerOf(context),
      ),
    // The same visibility rule as eventImpactPriors: walking the supersede
    // chain must not expose a proposed or rejected row to a viewer who may
    // only see accepted ones.
    supersedes: async (parent: ImpactPriorRow, _args: unknown, context: Context) => {
      if (!parent.supersedesId) return null;
      const row = await context.prisma.impactPrior.findUnique({
        where: { id: parent.supersedesId },
        include: { task: { select: { requesterId: true } } },
      });
      return row ? (visibleImpactPriors([row], viewerOf(context))[0] ?? null) : null;
    },
    decidedBy: (parent: ImpactPriorRow, _args: unknown, context: Context) =>
      parent.decidedById
        ? context.prisma.user.findUnique({ where: { id: parent.decidedById } })
        : null,
  },

  Event: {
    enrichmentTasks: async (parent: { id: string }, _args: unknown, context: Context) =>
      taskResolvers.Query.eventTasks(null, { eventId: parent.id }, context),
    impactPriors: async (parent: { id: string }, _args: unknown, context: Context) =>
      taskResolvers.Query.eventImpactPriors(null, { eventId: parent.id }, context),
  },

  Query: {
    // The Inbox's list (V2): ImpactPriors in one state across every Event,
    // newest first. Deciders only — it lists exactly what the caller may
    // decide, so clear-mvp needs no rule of its own. `proposed` by default.
    impactPriors: async (
      _parent: unknown,
      args: { state?: "proposed" | "accepted" | "rejected" | null; limit?: number | null; offset?: number | null },
      context: Context,
    ) => {
      requireRole(context, DECIDER_ROLES);
      return context.prisma.impactPrior.findMany({
        where: { state: args.state ?? "proposed" },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(args.limit ?? 50, 1), 200),
        skip: Math.max(args.offset ?? 0, 0),
      });
    },

    // Task status follows the Event's visibility: the same reader gate as
    // `event(id)`. Only `lastError` is narrower (requester + admins).
    task: async (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireContentReader(context);
      const task = await context.prisma.task.findUnique({ where: { id: args.id } });
      return task ? redactForViewer(task, user) : null;
    },

    eventTasks: async (_parent: unknown, args: { eventId: string }, context: Context) => {
      const user = requireContentReader(context);
      const rows = await context.prisma.task.findMany({
        where: { subjectType: EVENT_SUBJECT, subjectId: args.eventId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map((r) => redactForViewer(r, user));
    },

    eventImpactPriors: async (
      _parent: unknown,
      args: { eventId: string },
      context: Context,
    ) => {
      const user = requireContentReader(context);
      const rows = await context.prisma.impactPrior.findMany({
        where: { eventId: args.eventId },
        orderBy: { createdAt: "desc" },
        include: { task: { select: { requesterId: true } } },
      });
      return visibleImpactPriors(rows, user);
    },
  },

  Mutation: {
    // The trigger. Same gate as `escalateEvent`: a global admin or analyst
    // anywhere, a team content writer for the `teamId` they act on behalf
    // of. Records the CALLER as requester (escalateEvent records its
    // `userId` argument; a Task must not).
    requestEventEnrichment: async (
      _parent: unknown,
      args: {
        eventId: string;
        kind?: string | null;
        teamId?: string | null;
        horizonYears?: number | null;
      },
      context: Context,
    ) => {
      const { user } = await requireTeamContentWriter(context, args.teamId);
      const kind = args.kind ?? IMPACT_PRIOR_KIND;
      if (kind !== IMPACT_PRIOR_KIND) {
        throw badInput(`Unknown enrichment kind "${kind}"; the only kind is "${IMPACT_PRIOR_KIND}"`);
      }
      const horizonYears = args.horizonYears ?? DEFAULT_HORIZON_YEARS;
      if (!Number.isInteger(horizonYears) || horizonYears <= 0) {
        throw badInput("horizonYears must be a positive integer");
      }

      const event = await context.prisma.events.findUnique({
        where: { id: args.eventId },
        select: { id: true },
      });
      if (!event) throw notFound("Event");

      // One open Task per Event and kind: a second request returns the
      // existing one unchanged (its requester, team and horizon stay).
      const openWhere: Prisma.taskWhereInput = {
        kind,
        subjectType: EVENT_SUBJECT,
        subjectId: event.id,
        status: { in: ["PENDING", "LEASED"] },
      };
      const existing = await context.prisma.task.findFirst({ where: openWhere });
      if (existing) return redactForViewer(existing, user);

      // Per-requester daily cap, enforced here (not merely reported) because
      // API callers will not self-limit. Counts every Task this requester
      // created since UTC midnight, whatever became of it. Checked after the
      // dedupe: handing back an already-open Task costs nothing.
      const cap = env.TASK_REQUEST_DAILY_CAP;
      const today = await context.prisma.task.count({
        where: { requesterId: user.id, createdAt: { gte: utcMidnight(new Date()) } },
      });
      if (today >= cap) {
        throw forbidden(
          `Daily enrichment request cap reached: ${cap} requests per day. Try again after 00:00 UTC.`,
          "DAILY_CAP",
        );
      }

      let created: TaskRow;
      try {
        created = await context.prisma.task.create({
          data: {
            kind,
            subjectType: EVENT_SUBJECT,
            subjectId: event.id,
            payload: { horizonYears },
            // A signed-in person is `user`; an API-key caller is `api`.
            // Nothing writes `rule` yet.
            origin: context.authMethod === "api-key" ? "api" : "user",
            requesterId: user.id,
            teamId: args.teamId ?? null,
            maxAttempts: env.TASK_MAX_ATTEMPTS,
          },
        });
      } catch (e) {
        // Lost the create race against a concurrent identical request — the
        // partial unique index (tasks_open_subject_uk) rejected the
        // duplicate; return the winner instead of queueing the work twice.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          const winner = await context.prisma.task.findFirst({ where: openWhere });
          if (winner) return redactForViewer(winner, user);
        }
        throw e;
      }

      void logActivity(context.prisma, {
        userId: user.id,
        action: "task.requested",
        resourceType: "task",
        resourceId: created.id,
        metadata: { kind, subjectType: EVENT_SUBJECT, subjectId: event.id, teamId: args.teamId ?? null, horizonYears },
      });
      return created;
    },

    // The acceptance gate (V2). A Worker writes `proposed` only; a named
    // admin or analyst moves it to accepted or rejected with a rationale,
    // exactly once (the conditional write refuses a second decision).
    decideImpactPrior: async (
      _parent: unknown,
      args: { id: string; decision: "accepted" | "rejected"; rationale: string },
      context: Context,
    ) => {
      const user = requireRole(context, DECIDER_ROLES);
      const rationale = args.rationale.trim();
      if (!rationale) throw badInput("rationale is required");
      if (rationale.length > MAX_RATIONALE_LENGTH) {
        throw badInput(`rationale must be at most ${MAX_RATIONALE_LENGTH} characters`);
      }
      if (args.decision !== "accepted" && args.decision !== "rejected") {
        throw badInput('decision must be "accepted" or "rejected"');
      }
      const existing = await context.prisma.impactPrior.findUnique({ where: { id: args.id } });
      if (!existing) throw notFound("ImpactPrior");
      if (existing.state !== "proposed") {
        throw conflict(`ImpactPrior is already ${existing.state}`);
      }
      const now = new Date();
      const { count } = await context.prisma.impactPrior.updateMany({
        where: { id: args.id, state: "proposed" },
        data: { state: args.decision, decidedById: user.id, decidedAt: now, decisionRationale: rationale },
      });
      if (count === 0) throw conflict("ImpactPrior was decided meanwhile");
      void logActivity(context.prisma, {
        userId: user.id,
        action: "impact_prior.decided",
        resourceType: "impact_prior",
        resourceId: existing.id,
        metadata: { eventId: existing.eventId, taskId: existing.taskId, decision: args.decision },
      });
      return context.prisma.impactPrior.findUniqueOrThrow({ where: { id: args.id } });
    },

    // Cancellation, by the requester or a platform admin. PENDING ends now;
    // LEASED is flagged and the Worker finishes it at its next heartbeat,
    // completion or failure (a claim never hands out a flagged Task).
    cancelTask: async (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireAuth(context);
      const task = await context.prisma.task.findUnique({ where: { id: args.id } });
      if (!task) throw notFound("Task");
      if (!isPlatformAdmin(user) && task.requesterId !== user.id) {
        throw forbidden("Only the requester or a platform admin can cancel a Task");
      }
      const now = new Date();
      let count: number;
      if (task.status === "PENDING") {
        ({ count } = await context.prisma.task.updateMany({
          where: { id: task.id, status: "PENDING" },
          data: { status: "CANCELLED", cancelRequestedAt: now, cancelledById: user.id },
        }));
      } else if (task.status === "LEASED" && task.leaseExpiresAt && task.leaseExpiresAt < now) {
        // The Worker's lease has lapsed: nothing is coming back from it, so
        // finish the cancellation now rather than wait for a heartbeat that
        // will never arrive (and would otherwise leave the Event blocked).
        ({ count } = await context.prisma.task.updateMany({
          where: { id: task.id, status: "LEASED", leaseExpiresAt: { lt: now } },
          data: {
            status: "CANCELLED",
            leaseExpiresAt: null,
            cancelRequestedAt: task.cancelRequestedAt ?? now,
            cancelledById: task.cancelledById ?? user.id,
          },
        }));
      } else if (task.status === "LEASED") {
        if (task.cancelRequestedAt) {
          return task; // already requested; the Worker will finish it
        }
        ({ count } = await context.prisma.task.updateMany({
          where: { id: task.id, status: "LEASED", cancelRequestedAt: null },
          data: { cancelRequestedAt: now, cancelledById: user.id },
        }));
      } else {
        throw conflict(`Task is ${task.status} and can no longer be cancelled`);
      }
      if (count === 0) {
        throw conflict("Task changed while cancelling; retry");
      }
      void logActivity(context.prisma, {
        userId: user.id,
        action: "task.cancelled",
        resourceType: "task",
        resourceId: task.id,
        metadata: { kind: task.kind, subjectType: task.subjectType, subjectId: task.subjectId, wasLeased: task.status === "LEASED" },
      });
      return context.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    },

    // The claim. One statement leases up to `limit` of the oldest claimable
    // Tasks of `kind` — PENDING, or LEASED past their expiry (a lapsed lease
    // is reclaimed lazily here; there is no sweeper) — under
    // `FOR UPDATE SKIP LOCKED`, so two Workers claiming at once never hold
    // the same row. Prisma cannot express SKIP LOCKED, hence raw SQL; the
    // rows come back through Prisma so the shape matches every other read.
    claimTasks: async (
      _parent: unknown,
      args: { kind: string; limit?: number | null },
      context: Context,
    ) => {
      const worker = requireRole(context, [WORKER_ROLE]);
      const limit = Math.min(Math.max(args.limit ?? 1, 1), env.TASK_CLAIM_MAX);
      const leaseMinutes = env.TASK_LEASE_MINUTES;

      const sweptToFailed: string[] = [];
      const claimedIds = await context.prisma.$transaction(async (tx) => {
        // Lazy sweeps, since there is no sweeper process: the next claim is
        // where a lapsed lease is noticed. A lapsed lease whose cancellation
        // was requested is finished (the Worker that was told to stop never
        // answered); one whose Task has used up its attempts is FAILED.
        await tx.$executeRaw`
          UPDATE "tasks"
          SET "status" = 'CANCELLED',
              "lease_expires_at" = NULL,
              "updated_at" = now()
          WHERE "kind" = ${args.kind}
            AND "status" = 'LEASED'
            AND "cancel_requested_at" IS NOT NULL
            AND "lease_expires_at" < now()`;
        const swept = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "tasks"
          SET "status" = 'FAILED',
              "last_error" = COALESCE("last_error", 'lease expired after max attempts'),
              "lease_expires_at" = NULL,
              "updated_at" = now()
          WHERE "kind" = ${args.kind}
            AND "status" = 'LEASED'
            AND "lease_expires_at" < now()
            AND "attempts" >= "max_attempts"
          RETURNING "id"`;
        sweptToFailed.push(...swept.map((r) => r.id));
        const rows = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "tasks"
          SET "status" = 'LEASED',
              "lease_owner_id" = ${worker.id},
              "lease_token" = gen_random_uuid()::text,
              "lease_expires_at" = now() + (${leaseMinutes}::int * interval '1 minute'),
              "attempts" = "attempts" + 1,
              "updated_at" = now()
          WHERE "id" IN (
            SELECT "id" FROM "tasks"
            WHERE "kind" = ${args.kind}
              AND ("status" = 'PENDING'
                   OR ("status" = 'LEASED' AND "lease_expires_at" < now()))
              AND "attempts" < "max_attempts"
              AND "cancel_requested_at" IS NULL
            ORDER BY "created_at"
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING "id"`;
        return rows.map((r) => r.id);
      });

      // A Task the sweep just failed ends like any other failure: its
      // requester and reviewers hear about it. Best-effort and off the
      // claim's path: the leases are already handed out, so a failing read
      // here must not cost the Worker the ids it now holds.
      if (sweptToFailed.length > 0) {
        void (async () => {
          try {
            const failed = await context.prisma.task.findMany({ where: { id: { in: sweptToFailed } } });
            for (const task of failed) await notifyTaskOutcome(context.prisma, task, "failed");
          } catch (err) {
            console.error(`[claimTasks] could not notify the ${sweptToFailed.length} Task(s) the sweep failed:`, err);
          }
        })();
      }

      if (claimedIds.length === 0) return [];
      const claimed = await context.prisma.task.findMany({
        where: { id: { in: claimedIds } },
      });
      const order = new Map(claimedIds.map((id, i) => [id, i]));
      return claimed.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    },

    // Keep-alive. Extends the lease by TASK_LEASE_MINUTES from now; a Task
    // whose lease lapsed but was not yet reclaimed is still the owner's to
    // extend (the lapse is only acted on at a claim).
    heartbeatTask: async (
      _parent: unknown,
      args: { id: string; leaseToken: string },
      context: Context,
    ) => {
      const task = await requireLeaseOwner(context, args.id, args.leaseToken);
      const user = context.user!;
      if (task.cancelRequestedAt) return cancelLeasedTask(context.prisma, task.id, user.id, args.leaseToken);
      return writeAsLeaseOwner(context.prisma, task.id, user.id, args.leaseToken, {
        leaseExpiresAt: new Date(Date.now() + env.TASK_LEASE_MINUTES * 60_000),
      });
    },

    // Failure. Records the error and releases the Task: back to PENDING for
    // another attempt while attempts remain, FAILED (with this error as its
    // lastError, shown to the requester and admins) once they are used up.
    failTask: async (
      _parent: unknown,
      args: { id: string; leaseToken: string; error: string },
      context: Context,
    ) => {
      const task = await requireLeaseOwner(context, args.id, args.leaseToken);
      const user = context.user!;
      const error = args.error.trim().slice(0, MAX_ERROR_LENGTH);
      if (!error) throw badInput("error must not be empty");
      if (task.cancelRequestedAt) return cancelLeasedTask(context.prisma, task.id, user.id, args.leaseToken);
      const exhausted = task.attempts >= task.maxAttempts;
      const written = await writeAsLeaseOwner(context.prisma, task.id, user.id, args.leaseToken, {
        lastError: error,
        leaseExpiresAt: null,
        ...(exhausted
          ? { status: "FAILED" } // leaseOwnerId stays: who last held it.
          : { status: "PENDING", leaseOwnerId: null }),
      });
      // Only a terminal failure is news; a retry is the queue's business.
      if (written.status === "FAILED") void notifyTaskOutcome(context.prisma, written, "failed");
      return written;
    },

    // Completion: the Task's raw output, optional usage, and for
    // `event.impact_prior` an optional ImpactPrior proposal. With a proposal
    // the typed row is inserted (state `proposed`) in the same transaction
    // and the outcome is `produced`.
    completeTask: async (
      _parent: unknown,
      args: {
        id: string;
        leaseToken: string;
        result: Prisma.InputJsonValue;
        usage?: TaskUsageInput | null;
        impactPrior?: ImpactPriorInput | null;
      },
      context: Context,
    ) => {
      const task = await requireLeaseOwner(context, args.id, args.leaseToken);
      const user = context.user!;
      const now = new Date();
      const isImpactPriorTask =
        task.kind === IMPACT_PRIOR_KIND && task.subjectType === EVENT_SUBJECT;
      if (args.impactPrior && !isImpactPriorTask) {
        throw badInput(`An ImpactPrior can only complete a "${IMPACT_PRIOR_KIND}" Task`);
      }
      const usage = args.usage ? validateUsage(args.usage) : null;
      if (args.impactPrior) validateImpactPriorShape(args.impactPrior);
      if (task.cancelRequestedAt) return cancelLeasedTask(context.prisma, task.id, user.id, args.leaseToken);

      // The proposal must describe THIS Event: its hazard is one of the
      // Event's types and its country is the Event's. A Worker that found
      // cases for the wrong hazard or country has not found a prior.
      if (args.impactPrior) {
        const event = await context.prisma.events.findUnique({
          where: { id: task.subjectId },
          select: { id: true, types: true, locationId: true, originId: true, destinationId: true },
        });
        if (!event) throw notFound("Event");
        if (!event.types.includes(args.impactPrior.hazardType)) {
          throw badInput(
            `impactPrior.hazardType "${args.impactPrior.hazardType}" is not one of the Event's types (${event.types.join(", ") || "none"})`,
          );
        }
        const countryId = await resolveEventCountryId(context.prisma, event);
        if (!countryId) {
          throw badInput("The Event's country cannot be resolved; an ImpactPrior cannot be attached to it");
        }
        if (args.impactPrior.countryLocationId !== countryId) {
          throw badInput(
            `impactPrior.countryLocationId must be the Event's country (${countryId}), not "${args.impactPrior.countryLocationId}"`,
          );
        }
      }

      // For `event.impact_prior`, completing without a proposal means the
      // Worker looked and found no case: the Task records it, no row is
      // written, and the Event stays unenriched.
      const outcome = !isImpactPriorTask ? null : args.impactPrior ? "produced" : "no_prior_found";

      const completed = await context.prisma.$transaction(async (tx) => {
        // The Task first, conditionally on still holding the lease, so a
        // reclaimed Task's new owner never finds a stranger's result on it.
        const completed = await writeAsLeaseOwner(tx, task.id, user.id, args.leaseToken, {
          status: "COMPLETED",
          completedAt: now,
          result: args.result,
          outcome,
          ...(usage ?? {}),
          // leaseOwnerId stays as the record of who completed it.
          leaseExpiresAt: null,
        });
        // A cancel that landed mid-write won: nothing is produced.
        if (completed.status === "CANCELLED") return completed;
        if (args.impactPrior) {
          // Supersede, never overwrite: the newest existing ImpactPrior for
          // the Event (whatever its state) becomes this one's predecessor
          // and stays as it was.
          const previous = await tx.impactPrior.findFirst({
            where: { eventId: task.subjectId },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          await tx.impactPrior.create({
            data: {
              eventId: task.subjectId,
              taskId: task.id,
              supersedesId: previous?.id ?? null,
              hazardType: args.impactPrior.hazardType,
              countryLocationId: args.impactPrior.countryLocationId,
              geographicScope: args.impactPrior.geographicScope,
              horizonYears: args.impactPrior.horizonYears,
              populationGroup: args.impactPrior.populationGroup ?? null,
              metric: args.impactPrior.metric ?? null,
              lowerBound: args.impactPrior.lowerBound ?? null,
              upperBound: args.impactPrior.upperBound ?? null,
              numberOfCases: args.impactPrior.numberOfCases,
              basis: args.impactPrior.basis,
              validFrom: args.impactPrior.validFrom ?? null,
              validTo: args.impactPrior.validTo ?? null,
              methodVersion: args.impactPrior.methodVersion,
            },
          });
        }
        return completed;
      });
      // The fan-out (V2): requester, team analysts and platform admins hear
      // the outcome once the row is committed, never inside the transaction.
      if (completed.status === "COMPLETED") void notifyTaskOutcome(context.prisma, completed, "completed");
      return completed;
    },
  },
};
