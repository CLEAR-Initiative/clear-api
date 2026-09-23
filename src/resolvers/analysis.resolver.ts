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
import type { Prisma } from "../generated/prisma/client.js";

import type { Context } from "../context.js";
import { requireContentReader, requireRole } from "../utils/auth-guard.js";
import { DEFAULT_LOCALE } from "../utils/locales.js";
import { deepMergeTranslation } from "../utils/translation-merge.js";

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
 *  weekly so a typo can't wedge a frame into a tight regeneration loop. */
const CADENCE_MS: Record<string, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
  monthly: 2_592_000_000, // 30d
};
function nextRunFromCadence(cadence: string, from: Date): Date {
  const ms = CADENCE_MS[cadence.toLowerCase()] ?? CADENCE_MS.weekly;
  return new Date(from.getTime() + ms);
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

    // Automation subscriptions. Admin sees all; a scoped listing per team is a
    // later refinement (Phase 4 surfaces the scheduler + ownership UX).
    analysisAutomations: async (
      _parent: unknown,
      args: { teamId?: string | null; enabledOnly?: boolean | null },
      context: Context,
    ) => {
      requireContentReader(context);
      return context.prisma.analysisAutomation.findMany({
        where: {
          ...(args.teamId ? { teamId: args.teamId } : {}),
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
    ): Promise<{ analysisId: string; supersededPrevious: boolean }> => {
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

      return context.prisma.$transaction(async (tx) => {
        const superseded = await tx.analysis.updateMany({
          where: {
            locationIds: { equals: locationIds },
            eventTypes: { equals: eventTypes },
            needSectors: { equals: needSectors },
            windowStart: input.windowStart,
            windowEnd,
            schemaVersion: input.schemaVersion,
            validTo: null,
          },
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
          },
        });

        return {
          analysisId: created.id,
          supersededPrevious: superseded.count > 0,
        };
      });
    },

    createAnalysisAutomation: async (
      _parent: unknown,
      args: { input: CreateAnalysisAutomationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;
      return context.prisma.analysisAutomation.create({
        data: {
          locationIds: canonicalizeArray(input.locationIds),
          eventTypes: canonicalizeArray(input.eventTypes),
          needSectors: canonicalizeArray(input.needSectors),
          windowStart: input.windowStart,
          cadence: input.cadence,
          teamId: input.teamId ?? null,
          createdByUserId: context.user?.id ?? null,
        },
      });
    },

    updateAnalysisAutomation: async (
      _parent: unknown,
      args: { id: string; input: UpdateAnalysisAutomationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
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
      requireRole(context, ["admin", "analyst"]);
      await context.prisma.analysisAutomation.delete({ where: { id: args.id } });
      return true;
    },

    // User enqueues an on-demand analysis for a frame (ADR-0007 §4). Dedupes
    // against an existing PENDING request for the same frame so a double-submit
    // doesn't queue the same generation twice.
    requestAnalysis: async (
      _parent: unknown,
      args: { input: FrameInput & { teamId?: string | null } },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;
      const existing = await context.prisma.analysisRequest.findFirst({
        where: { ...frameWhere(input), status: "PENDING" },
      });
      if (existing) return existing;
      return context.prisma.analysisRequest.create({
        data: {
          locationIds: canonicalizeArray(input.locationIds),
          eventTypes: canonicalizeArray(input.eventTypes),
          needSectors: canonicalizeArray(input.needSectors),
          windowStart: input.windowStart,
          windowEnd: input.windowEnd ?? null,
          teamId: input.teamId ?? null,
          requestedByUserId: context.user?.id ?? null,
        },
      });
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
        select: { id: true, cadence: true },
      });
      await context.prisma.$transaction(
        rows.map((r) =>
          context.prisma.analysisAutomation.update({
            where: { id: r.id },
            data: { lastRunAt: now, nextRunAt: nextRunFromCadence(r.cadence, now) },
          }),
        ),
      );
      return rows.length;
    },
  },
};
