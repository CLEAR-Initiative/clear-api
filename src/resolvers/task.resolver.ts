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

export const IMPACT_PRIOR_KIND = "event.impact_prior";
const EVENT_SUBJECT = "event";
const DEFAULT_HORIZON_YEARS = 10;
const WORKER_ROLE = "worker";

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
function leaseError(task: TaskRow | null, userId: string): GraphQLError {
  if (!task) return notFound("Task");
  if (task.status !== "LEASED") {
    return conflict(`Task is ${task.status}, not LEASED`, "NOT_LEASED");
  }
  if (task.leaseOwnerId !== userId) {
    return forbidden("You do not hold the lease on this Task", "NOT_LEASE_OWNER");
  }
  return conflict("Task changed while writing; retry", "NOT_LEASED");
}

/**
 * The Worker-side ownership check shared by heartbeat / complete / fail:
 * the caller holds the `worker` role, the Task exists, is LEASED, and the
 * lease is the caller's. A fast pre-check only — the write itself goes
 * through {@link writeAsLeaseOwner}, which re-asserts the lease atomically.
 */
async function requireLeaseOwner(context: Context, id: string): Promise<TaskRow> {
  const user = requireRole(context, [WORKER_ROLE]);
  const task = await context.prisma.task.findUnique({ where: { id } });
  if (!task || task.status !== "LEASED" || task.leaseOwnerId !== user.id) {
    throw leaseError(task, user.id);
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
): Promise<TaskRow> {
  await tx.task.updateMany({
    where: { id, status: "LEASED", leaseOwnerId: userId },
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
  data: Prisma.taskUpdateManyMutationInput,
): Promise<TaskRow> {
  const { count } = await tx.task.updateMany({
    where: { id, status: "LEASED", leaseOwnerId: userId, cancelRequestedAt: null },
    data,
  });
  if (count === 0) {
    const current = await tx.task.findUnique({ where: { id } });
    if (
      current &&
      current.status === "LEASED" &&
      current.leaseOwnerId === userId &&
      current.cancelRequestedAt
    ) {
      return cancelLeasedTask(tx, id, userId);
    }
    throw leaseError(current, userId);
  }
  return tx.task.findUniqueOrThrow({ where: { id } });
}

/** `lastError` is the requester's and platform admins' to see; everyone
 *  else gets the Task with it blanked (the `ownView` pattern of
 *  `requestAnalysis`). */
function redactForViewer<T extends { requesterId: string | null; lastError: string | null }>(
  row: T,
  user: { id: string; role?: string | null },
): T {
  if (isPlatformAdmin(user) || row.requesterId === user.id) return row;
  return { ...row, lastError: null };
}

/** V1 visibility for ImpactPriors: admins, analysts and the requesting user
 *  see every state; everyone else sees `accepted` only. (V2 refines
 *  `rejected` to deciders only.) */
function visibleImpactPriors<T extends ImpactPriorRow & { task: { requesterId: string | null } }>(
  rows: T[],
  user: { id: string; role?: string | null },
): ImpactPriorRow[] {
  const decider = isPlatformAdmin(user) || user.role === "analyst";
  return rows
    .filter((r) => decider || r.state === "accepted" || r.task.requesterId === user.id)
    .map(({ task: _task, ...rest }) => rest);
}

export const taskResolvers = {
  Task: {
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
    task: (parent: ImpactPriorRow, _args: unknown, context: Context) =>
      context.prisma.task.findUniqueOrThrow({ where: { id: parent.taskId } }),
    supersedes: (parent: ImpactPriorRow, _args: unknown, context: Context) =>
      parent.supersedesId
        ? context.prisma.impactPrior.findUnique({ where: { id: parent.supersedesId } })
        : null,
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
      if (existing) return existing;

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
          if (winner) return winner;
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

      const claimedIds = await context.prisma.$transaction(async (tx) => {
        // A lapsed lease whose Task has used up its attempts is FAILED here,
        // the same lazy way an expired lease is reclaimed below: there is no
        // sweeper, so the next claim is where the expiry is noticed.
        await tx.$executeRaw`
          UPDATE "tasks"
          SET "status" = 'FAILED',
              "last_error" = COALESCE("last_error", 'lease expired after max attempts'),
              "lease_expires_at" = NULL,
              "updated_at" = now()
          WHERE "kind" = ${args.kind}
            AND "status" = 'LEASED'
            AND "lease_expires_at" < now()
            AND "attempts" >= "max_attempts"`;
        const rows = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "tasks"
          SET "status" = 'LEASED',
              "lease_owner_id" = ${worker.id},
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
    heartbeatTask: async (_parent: unknown, args: { id: string }, context: Context) => {
      const task = await requireLeaseOwner(context, args.id);
      const user = context.user!;
      if (task.cancelRequestedAt) return cancelLeasedTask(context.prisma, task.id, user.id);
      return writeAsLeaseOwner(context.prisma, task.id, user.id, {
        leaseExpiresAt: new Date(Date.now() + env.TASK_LEASE_MINUTES * 60_000),
      });
    },

    // Failure. Records the error and releases the Task: back to PENDING for
    // another attempt while attempts remain, FAILED (with this error as its
    // lastError, shown to the requester and admins) once they are used up.
    failTask: async (_parent: unknown, args: { id: string; error: string }, context: Context) => {
      const task = await requireLeaseOwner(context, args.id);
      const user = context.user!;
      const error = args.error.trim();
      if (!error) throw badInput("error must not be empty");
      if (task.cancelRequestedAt) return cancelLeasedTask(context.prisma, task.id, user.id);
      const exhausted = task.attempts >= task.maxAttempts;
      return writeAsLeaseOwner(context.prisma, task.id, user.id, {
        lastError: error,
        leaseExpiresAt: null,
        ...(exhausted
          ? { status: "FAILED" } // leaseOwnerId stays: who last held it.
          : { status: "PENDING", leaseOwnerId: null }),
      });
    },

    // Completion: the Task's raw output, optional usage, and for
    // `event.impact_prior` an optional ImpactPrior proposal. With a proposal
    // the typed row is inserted (state `proposed`) in the same transaction
    // and the outcome is `produced`.
    completeTask: async (
      _parent: unknown,
      args: {
        id: string;
        result: Prisma.InputJsonValue;
        usage?: TaskUsageInput | null;
        impactPrior?: ImpactPriorInput | null;
      },
      context: Context,
    ) => {
      const task = await requireLeaseOwner(context, args.id);
      const user = context.user!;
      const now = new Date();
      if (args.impactPrior && (task.kind !== IMPACT_PRIOR_KIND || task.subjectType !== EVENT_SUBJECT)) {
        throw badInput(`An ImpactPrior can only complete a "${IMPACT_PRIOR_KIND}" Task`);
      }

      if (task.cancelRequestedAt) return cancelLeasedTask(context.prisma, task.id, user.id);

      return context.prisma.$transaction(async (tx) => {
        // The Task first, conditionally on still holding the lease, so a
        // reclaimed Task's new owner never finds a stranger's result on it.
        const completed = await writeAsLeaseOwner(tx, task.id, user.id, {
          status: "COMPLETED",
          completedAt: now,
          result: args.result,
          outcome: args.impactPrior ? "produced" : null,
          // leaseOwnerId stays as the record of who completed it.
          leaseExpiresAt: null,
        });
        // A cancel that landed mid-write won: nothing is produced.
        if (completed.status === "CANCELLED") return completed;
        if (args.impactPrior) {
          await tx.impactPrior.create({
            data: {
              eventId: task.subjectId,
              taskId: task.id,
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
    },
  },
};
