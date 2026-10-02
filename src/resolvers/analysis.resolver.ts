/**
 * Unified frame-scoped analysis resolver (ADR-0007).
 *
 * Read path mirrors `situationAnalysis`: the dashboard reads one current row
 * per FRAME (bitemporal, `asOf` for history). Write path `upsertAnalysis` is
 * the pipeline generator's single entry point — bitemporal supersede-then-
 * insert in one transaction, keyed on the frame columns.
 *
 * The frame arrays (locationIds / eventTypes / needSectors) are canonicalised
 * — sorted + de-duplicated — on every read and write, so `[a,b]` and `[b,a]`
 * address the same row. That canonicalisation is what makes the migration's
 * partial-unique index (over the array columns) a reliable identity; keep the
 * two in lockstep.
 *
 * `analysisAutomation` CRUD manages the subscriptions that keep a frame
 * current on a cadence; the scheduler that acts on them is Phase 4.
 */

import { GraphQLError } from "graphql";
import { Prisma } from "../generated/prisma/client.js";

import type { Context } from "../context.js";
import {
  isPlatformAdmin,
  requireContentReader,
  requireRole,
  resolveTeamMembership,
} from "../utils/auth-guard.js";
import { DEFAULT_LOCALE } from "../utils/locales.js";
import { deepMergeTranslation } from "../utils/translation-merge.js";
import { buildFilterClause } from "./knowledgebase.resolver.js";

/** Minimum gap between two actual regenerations of a frame's analysis (ADR-0008).
 *  A trigger inside this window no-ops (bumps `lastSyncedAt` only) unless forced.
 *  Global across the manual + automation triggers — it's a property of the
 *  frame's live analysis, not of a trigger. */
const MIN_REGEN_GAP_MS = 24 * 60 * 60 * 1000;

/** Sort + de-duplicate a frame array so identity is order-insensitive. A
 *  missing/null input canonicalises to `[]` (the "no filter on this axis"
 *  convention the migration's NULLS-NOT-DISTINCT index relies on). */
function canonicalizeArray(xs?: string[] | null): string[] {
  return Array.from(new Set(xs ?? [])).sort();
}

interface FrameInput {
  locationIds?: string[] | null;
  eventTypes?: string[] | null;
  needSectors?: string[] | null;
  windowStart: Date;
  windowEnd?: Date | null;
}

interface UpsertAnalysisInput extends FrameInput {
  data: Prisma.InputJsonValue;
  sourceReportIds: string[];
  generatedByModel: string;
  generationCostUsd?: number | null;
  schemaVersion: string;
  /** Bypass the 24h regeneration floor (ADR-0008). */
  force?: boolean | null;
}

/** A frame → KnowledgebaseFilters, matching the pipeline's `build_rag_filters`:
 *  a single-location frame scopes by SUBTREE (`countryLocationId`) since KB
 *  chunks are tagged at leaf admin ids; a multi-location frame matches its ids
 *  by overlap. Used by the freshness watermark so it sees the same corpus the
 *  analysis is generated from. */
function frameToKbFilters(frame: FrameInput) {
  const locationIds = canonicalizeArray(frame.locationIds);
  const eventTypes = canonicalizeArray(frame.eventTypes);
  const needSectors = canonicalizeArray(frame.needSectors);
  return {
    ...(locationIds.length === 1
      ? { countryLocationId: locationIds[0] }
      : locationIds.length > 0
        ? { locationIds }
        : {}),
    ...(eventTypes.length > 0 ? { eventTypes } : {}),
    ...(needSectors.length > 0 ? { needSectors } : {}),
    // Freshness is about INGESTION, not retrievability by the current embedding
    // model — count all KB rows for the frame regardless of embedding config.
    // (Also avoids pulling EMBEDDING_* env into a plain count query.)
    currentEmbeddingModelOnly: false,
  };
}

/** The frame columns as a Prisma `where` fragment (exact match on each axis).
 *  Arrays are compared with `equals` against their canonical form; a null
 *  windowEnd matches the rolling ("to present") rows. */
function frameWhere(frame: FrameInput) {
  return {
    locationIds: { equals: canonicalizeArray(frame.locationIds) },
    eventTypes: { equals: canonicalizeArray(frame.eventTypes) },
    needSectors: { equals: canonicalizeArray(frame.needSectors) },
    windowStart: frame.windowStart,
    windowEnd: frame.windowEnd ?? null,
  };
}

interface CreateAnalysisAutomationInput {
  locationIds?: string[] | null;
  eventTypes?: string[] | null;
  needSectors?: string[] | null;
  windowStart: Date;
  cadence: string;
  teamId?: string | null;
}

interface UpdateAnalysisAutomationInput {
  cadence?: string | null;
  enabled?: boolean | null;
}

/** Cadence → milliseconds until the next run. Unknown cadences fall back to
 *  weekly so a typo can't wedge a frame into a tight regeneration loop.
 *  (`monthly` is a 30-day approximation — calendar-month scheduling is a later
 *  refinement.) */
const CADENCE_MS: Record<string, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
  monthly: 2_592_000_000, // 30d
};
/** Next run anchored to the PRIOR scheduled time, not wall-clock mark-time — so a
 *  late pickup doesn't push the cadence progressively later each cycle. Missed
 *  cycles skip forward to the next future slot; a never-run row schedules from
 *  `now`. */
function nextScheduledRun(cadence: string, priorNextRunAt: Date | null, now: Date): Date {
  const ms = CADENCE_MS[cadence.toLowerCase()] ?? CADENCE_MS.weekly;
  let next = (priorNextRunAt ?? now).getTime() + ms;
  while (next <= now.getTime()) next += ms;
  return new Date(next);
}

/** Team-ownership gate for automation writes. A platform admin passes
 *  unconditionally; anyone else must be a member of the owning team
 *  (FORBIDDEN otherwise). A null team is a system/platform-level
 *  automation and is admin-only. */
async function requireAutomationTeamAccess(
  context: Context,
  user: NonNullable<Context["user"]>,
  teamId: string | null | undefined,
): Promise<void> {
  if (isPlatformAdmin(user)) return;
  if (!teamId) {
    throw new GraphQLError("Only a platform admin can manage a team-less automation", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  await resolveTeamMembership(context.prisma, user.id, teamId, user.role);
}

/** Load an automation's owning team for an id-addressed write, then apply
 *  the team gate. Missing id → NOT_FOUND (checked before the gate, matching
 *  what an admin would see). */
async function requireAutomationAccessById(
  context: Context,
  user: NonNullable<Context["user"]>,
  id: string,
): Promise<void> {
  const automation = await context.prisma.analysisAutomation.findUnique({
    where: { id },
    select: { teamId: true },
  });
  if (!automation) {
    throw new GraphQLError("Analysis automation not found", {
      extensions: { code: "NOT_FOUND" },
    });
  }
  await requireAutomationTeamAccess(context, user, automation.teamId);
}

export const analysisResolvers = {
  // Overlay the active-locale translation onto the analysis `data` blob
  // (mirrors SituationAnalysis.data). The generation pipeline writes one
  // translation row per locale carrying only the translated prose leaves;
  // deepMergeTranslation splices them over canonical so numbers / ids / enums
  // stay authoritative. Short-circuits to canonical for `en` and when no
  // translation exists yet (the loader's miss also enqueues a durable
  // (re)translation request).
  Analysis: {
    data: async (
      parent: { id: string; data: unknown },
      _args: unknown,
      context: Context,
    ) => {
      if (context.locale === DEFAULT_LOCALE) return parent.data;
      const tr = await context.translationLoader.load("analysis", parent.id);
      if (!tr) return parent.data;
      return deepMergeTranslation(parent.data, tr);
    },
  },

  Query: {
    // One current analysis for a frame. Bitemporal: returns the row whose
    // validity window covers `asOf` (default now). Schema version pinned if
    // asked, else newest wins (versions coexist per frame).
    analysis: async (
      _parent: unknown,
      args: { frame: FrameInput; asOf?: Date | null; schemaVersion?: string | null },
      context: Context,
    ) => {
      requireContentReader(context);
      const asOf = args.asOf ?? new Date();
      return context.prisma.analysis.findFirst({
        where: {
          ...frameWhere(args.frame),
          ...(args.schemaVersion ? { schemaVersion: args.schemaVersion } : {}),
          validFrom: { lte: asOf },
          OR: [{ validTo: null }, { validTo: { gt: asOf } }],
        },
        orderBy: { validFrom: "desc" },
      });
    },

    // By-id read, including superseded history rows (the frame-keyed
    // `analysis` query only returns the current row).
    analysisById: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireContentReader(context);
      return context.prisma.analysis.findUnique({ where: { id: args.id } });
    },

    // Automation subscriptions. A platform admin sees whatever is asked
    // (all, or one team's). Anyone else is scoped to their own teams: a
    // `teamId` they don't belong to is FORBIDDEN, and no `teamId` lists only
    // the automations of teams they are a member of (never team-less/system
    // rows). The pipeline drains via `dueAnalysisAutomations`, not this.
    analysisAutomations: async (
      _parent: unknown,
      args: { teamId?: string | null; enabledOnly?: boolean | null },
      context: Context,
    ) => {
      const user = requireContentReader(context);
      let teamFilter: Prisma.analysisAutomationWhereInput = args.teamId
        ? { teamId: args.teamId }
        : {};
      if (!isPlatformAdmin(user)) {
        if (args.teamId) {
          await resolveTeamMembership(context.prisma, user.id, args.teamId, user.role);
        } else {
          const memberships = await context.prisma.teamMembers.findMany({
            where: { userId: user.id },
            select: { teamId: true },
          });
          teamFilter = { teamId: { in: memberships.map((m) => m.teamId) } };
        }
      }
      return context.prisma.analysisAutomation.findMany({
        where: {
          ...teamFilter,
          ...(args.enabledOnly ? { enabled: true } : {}),
        },
        orderBy: { createdAt: "desc" },
      });
    },

    // Pipeline drain (ADR-0007 §4): the oldest PENDING on-demand requests. The
    // sensor generates each frame and marks it GENERATED / FAILED.
    pendingAnalyses: async (
      _parent: unknown,
      args: { limit?: number | null },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      return context.prisma.analysisRequest.findMany({
        where: { status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: Math.min(Math.max(args.limit ?? 20, 1), 100),
      });
    },

    // Scheduler drain (ADR-0007 §5): enabled automations that are DUE — never
    // run (nextRunAt null) or nextRunAt in the past. The pipeline groups these
    // by frame and regenerates each frame at the minimum cadence across its
    // subscribers. Admin / pipeline only.
    dueAnalysisAutomations: async (
      _parent: unknown,
      args: { limit?: number | null },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const now = new Date();
      return context.prisma.analysisAutomation.findMany({
        where: {
          enabled: true,
          OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
        },
        orderBy: { nextRunAt: { sort: "asc", nulls: "first" } },
        take: Math.min(Math.max(args.limit ?? 100, 1), 500),
      });
    },

    // Freshness watermark for a frame (ADR-0008): the newest ingestion time +
    // count over the `knowledgebase` corpus the analysis is generated from.
    // Reuses the KB search's exact filter (incl. single-location → subtree
    // expansion) so "new evidence" means what retrieval would actually see. The
    // drain compares `latestEvidenceAt` to the live analysis's `generatedAt`.
    frameEvidenceWatermark: async (
      _parent: unknown,
      args: { frame: FrameInput },
      context: Context,
    ): Promise<{ latestEvidenceAt: Date | null; evidenceCount: number }> => {
      requireRole(context, ["admin", "pipeline"]);
      const params: unknown[] = [];
      const whereClause = buildFilterClause(frameToKbFilters(args.frame), params);
      const sql =
        `SELECT MAX("created_at") AS "latestEvidenceAt", ` +
        `COUNT(*)::int AS "evidenceCount" FROM "knowledgebase" ${whereClause}`;
      const rows = await context.prisma.$queryRawUnsafe<
        { latestEvidenceAt: Date | null; evidenceCount: number }[]
      >(sql, ...params);
      const row = rows[0];
      return {
        latestEvidenceAt: row?.latestEvidenceAt ?? null,
        evidenceCount: Number(row?.evidenceCount ?? 0),
      };
    },
  },

  Mutation: {
    // Pipeline write. Bitemporal supersede-then-insert over the frame columns
    // — same shape as `upsertSituationAnalysis`. Stamp validTo on the previous
    // current row FIRST so the partial-unique index (WHERE valid_to IS NULL)
    // doesn't reject the insert.
    upsertAnalysis: async (
      _parent: unknown,
      args: { input: UpsertAnalysisInput },
      context: Context,
    ): Promise<{
      analysisId: string;
      supersededPrevious: boolean;
      skipped: boolean;
      reason: string | null;
    }> => {
      requireRole(context, ["admin", "pipeline"]);
      const { input } = args;

      if (!input.schemaVersion) {
        throw new GraphQLError("upsertAnalysis: schemaVersion is required", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const now = new Date();
      const locationIds = canonicalizeArray(input.locationIds);
      const eventTypes = canonicalizeArray(input.eventTypes);
      const needSectors = canonicalizeArray(input.needSectors);
      const windowEnd = input.windowEnd ?? null;
      const frameMatch = {
        locationIds: { equals: locationIds },
        eventTypes: { equals: eventTypes },
        needSectors: { equals: needSectors },
        windowStart: input.windowStart,
        windowEnd,
        schemaVersion: input.schemaVersion,
        validTo: null,
      };

      return context.prisma.$transaction(async (tx) => {
        // Authoritative 24h floor (ADR-0008): defends the write choke point
        // against races / direct callers even if a drain's pre-check passed.
        // Within 24h and not forced → no-op: bump lastSyncedAt on the current
        // row, write no new version.
        const current = await tx.analysis.findFirst({
          where: frameMatch,
          select: { id: true, generatedAt: true },
        });
        if (
          current &&
          !input.force &&
          now.getTime() - current.generatedAt.getTime() < MIN_REGEN_GAP_MS
        ) {
          await tx.analysis.update({
            where: { id: current.id },
            data: { lastSyncedAt: now },
          });
          return {
            analysisId: current.id,
            supersededPrevious: false,
            skipped: true,
            reason: "within-24h-floor",
          };
        }

        // Stamp validTo on the previous current row FIRST so the partial-unique
        // index (WHERE valid_to IS NULL) doesn't reject the insert.
        const superseded = await tx.analysis.updateMany({
          where: frameMatch,
          data: { validTo: now },
        });

        const created = await tx.analysis.create({
          data: {
            locationIds,
            eventTypes,
            needSectors,
            windowStart: input.windowStart,
            windowEnd,
            data: input.data,
            sourceReportIds: input.sourceReportIds,
            generatedByModel: input.generatedByModel,
            generationCostUsd: input.generationCostUsd ?? null,
            schemaVersion: input.schemaVersion,
            validFrom: now,
            lastSyncedAt: now,
          },
        });

        return {
          analysisId: created.id,
          supersededPrevious: superseded.count > 0,
          skipped: false,
          reason: null,
        };
      });
    },

    // Pipeline (ADR-0008): bump the current analysis row's lastSyncedAt for a
    // frame WITHOUT regenerating — used when the drain's gate decides to skip
    // (within 24h, or no new evidence). Returns false when no current row
    // exists for the frame.
    touchAnalysisSynced: async (
      _parent: unknown,
      args: { frame: FrameInput },
      context: Context,
    ): Promise<boolean> => {
      requireRole(context, ["admin", "pipeline"]);
      const updated = await context.prisma.analysis.updateMany({
        where: { ...frameWhere(args.frame), validTo: null },
        data: { lastSyncedAt: new Date() },
      });
      return updated.count > 0;
    },

    createAnalysisAutomation: async (
      _parent: unknown,
      args: { input: CreateAnalysisAutomationInput },
      context: Context,
    ) => {
      const user = requireRole(context, ["admin", "analyst"]);
      const { input } = args;
      await requireAutomationTeamAccess(context, user, input.teamId);
      const data = {
        locationIds: canonicalizeArray(input.locationIds),
        eventTypes: canonicalizeArray(input.eventTypes),
        needSectors: canonicalizeArray(input.needSectors),
        windowStart: input.windowStart,
        cadence: input.cadence,
        teamId: input.teamId ?? null,
        createdByUserId: context.user?.id ?? null,
      };
      try {
        return await context.prisma.analysisAutomation.create({ data });
      } catch (e) {
        // Re-subscribe to the same (frame, owner): the partial-unique index
        // rejects the duplicate — update the existing subscription's cadence
        // instead (the "updates cadence rather than duplicating" contract).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          const existing = await context.prisma.analysisAutomation.findFirst({
            where: {
              locationIds: { equals: data.locationIds },
              eventTypes: { equals: data.eventTypes },
              needSectors: { equals: data.needSectors },
              windowStart: data.windowStart,
              teamId: data.teamId,
              createdByUserId: data.createdByUserId,
            },
          });
          if (existing) {
            return context.prisma.analysisAutomation.update({
              where: { id: existing.id },
              data: { cadence: data.cadence, enabled: true },
            });
          }
        }
        throw e;
      }
    },

    updateAnalysisAutomation: async (
      _parent: unknown,
      args: { id: string; input: UpdateAnalysisAutomationInput },
      context: Context,
    ) => {
      const user = requireRole(context, ["admin", "analyst"]);
      await requireAutomationAccessById(context, user, args.id);
      const { input } = args;
      return context.prisma.analysisAutomation.update({
        where: { id: args.id },
        data: {
          ...(input.cadence != null ? { cadence: input.cadence } : {}),
          ...(input.enabled != null ? { enabled: input.enabled } : {}),
        },
      });
    },

    deleteAnalysisAutomation: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ): Promise<boolean> => {
      const user = requireRole(context, ["admin", "analyst"]);
      await requireAutomationAccessById(context, user, args.id);
      await context.prisma.analysisAutomation.delete({ where: { id: args.id } });
      return true;
    },

    // User enqueues an on-demand analysis for a frame (ADR-0007 §4). Dedupes
    // against an existing PENDING request for the same frame so a double-submit
    // doesn't queue the same generation twice.
    requestAnalysis: async (
      _parent: unknown,
      args: { input: FrameInput & { teamId?: string | null; force?: boolean | null } },
      context: Context,
    ) => {
      const user = requireRole(context, ["admin", "analyst"]);
      const { input } = args;
      // Force bypasses the regeneration gate (ADR-0008) — admin only.
      const force = input.force ?? false;
      if (force && !isPlatformAdmin(user)) {
        throw new GraphQLError("Only a platform admin can force an analysis regeneration", {
          extensions: { code: "FORBIDDEN" },
        });
      }
      // A team-attributed request must come from a member of that team
      // (admins bypass). A team-less request stays open to admin/analyst.
      if (input.teamId) {
        await resolveTeamMembership(context.prisma, user.id, input.teamId, user.role);
      }
      // A pending request for the same frame may belong to another team: dedupe
      // onto it, but never hand a non-admin that team's requester or error.
      const ownView = <T extends { teamId: string | null; requestedByUserId: string | null; lastError: string | null }>(
        row: T,
      ): T =>
        isPlatformAdmin(user) || (row.teamId ?? null) === (input.teamId ?? null)
          ? row
          : { ...row, teamId: null, requestedByUserId: null, lastError: null };
      const existing = await context.prisma.analysisRequest.findFirst({
        where: { ...frameWhere(input), status: "PENDING" },
      });
      if (existing) {
        // Upgrade an existing non-forced PENDING to forced when an admin forces
        // the same frame, so the drain honours the force rather than the first
        // (gated) request winning.
        if (force && !existing.force) {
          const upgraded = await context.prisma.analysisRequest.update({
            where: { id: existing.id },
            data: { force: true },
          });
          return ownView(upgraded);
        }
        return ownView(existing);
      }
      try {
        return await context.prisma.analysisRequest.create({
          data: {
            locationIds: canonicalizeArray(input.locationIds),
            eventTypes: canonicalizeArray(input.eventTypes),
            needSectors: canonicalizeArray(input.needSectors),
            windowStart: input.windowStart,
            windowEnd: input.windowEnd ?? null,
            teamId: input.teamId ?? null,
            requestedByUserId: context.user?.id ?? null,
            force,
          },
        });
      } catch (e) {
        // Lost the create race against a concurrent identical request — the
        // partial-unique index (PENDING per frame) rejected the duplicate;
        // return the winner instead of double-generating.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          const winner = await context.prisma.analysisRequest.findFirst({
            where: { ...frameWhere(input), status: "PENDING" },
          });
          if (winner) return ownView(winner);
        }
        throw e;
      }
    },

    // Pipeline: mark a drained request done after its analysis was upserted.
    markAnalysisRequestGenerated: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      return context.prisma.analysisRequest.update({
        where: { id: args.id },
        data: { status: "GENERATED" },
      });
    },

    // Pipeline: record a generation failure (bumps the attempt counter so a
    // persistently failing request can be surfaced rather than looping).
    markAnalysisRequestFailed: async (
      _parent: unknown,
      args: { id: string; error?: string | null },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      return context.prisma.analysisRequest.update({
        where: { id: args.id },
        data: {
          status: "FAILED",
          attempts: { increment: 1 },
          lastError: args.error ?? null,
        },
      });
    },

    // Scheduler: stamp lastRunAt + nextRunAt (from each row's cadence) on the
    // automations whose frame was just regenerated (ADR-0007 §5). Called with
    // ALL the automation ids sharing a frame, so a weekly subscriber's clock is
    // reset alongside the daily one that actually triggered the run — the
    // min-cadence subscriber drives the frame. Returns the count updated.
    markAnalysisAutomationsRan: async (
      _parent: unknown,
      args: { ids: string[] },
      context: Context,
    ): Promise<number> => {
      requireRole(context, ["admin", "pipeline"]);
      const now = new Date();
      const rows = await context.prisma.analysisAutomation.findMany({
        where: { id: { in: args.ids } },
        select: { id: true, cadence: true, nextRunAt: true },
      });
      await context.prisma.$transaction(
        rows.map((r) =>
          context.prisma.analysisAutomation.update({
            where: { id: r.id },
            data: {
              lastRunAt: now,
              nextRunAt: nextScheduledRun(r.cadence, r.nextRunAt, now),
            },
          }),
        ),
      );
      return rows.length;
    },
  },
};
