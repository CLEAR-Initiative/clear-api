/**
 * Structured datapoint resolver - Layer 2 read path.
 *
 * Two entry points:
 *   - Query `reportDatapoint(reportId)` - per-report structured
 *     payload for the dashboard's provenance drill-down and the
 *     chatbot's "what did report X say?" path. Any authenticated
 *     content reader.
 *   - Mutation `upsertReportDatapoints(input)` - pipeline-only.
 *     Replaces the row for `reportId` atomically. Idempotent via
 *     Prisma's `upsert`.
 *
 * The aggregated-datapoints surface (Layer 1) ships in Phase 2.
 */

import { GraphQLError } from "graphql";
import type { Prisma } from "../generated/prisma/client.js";

import type { Context } from "../context.js";
import { requireContentReader, requireRole } from "../utils/auth-guard.js";
import {
  aggregateReports,
  buildApiMentions,
  buildApiReliabilityByOrg,
  estimateCurrentTotalFromRows,
  filterApiMentionsToWindow,
  finaliseReadTimeQuality,
  API_RECONCILING_TYPES,
  STOCK_FLOW_PAIRS,
  type LocationMetadataRow,
  type ReportRow,
} from "../services/datapoint-aggregation.js";

interface UpsertReportDatapointsInput {
  reportId: string;
  reportTitle: string;
  sourceUrl: string;
  publishedAt: Date;
  reportingPeriodStart?: Date | null;
  reportingPeriodEnd?: Date | null;
  locationIds: string[];
  locationPcodes: string[];
  eventTypes: string[];
  totalAffected?: number | null;
  totalDisplaced?: number | null;
  totalKilled?: number | null;
  data: Prisma.InputJsonValue;
  schemaVersion: string;
  extractedByModel: string;
  sourceId?: string | null;
}

// Default schema version - MUST match the SCHEMA_VERSION constant in the
// Python-side extraction module (datapoints_schemas.py), currently "v3". A
// version-less `aggregatedDatapoint` query reads buckets of this version, so a
// mismatch makes freshly-aggregated buckets go unread. The interval-and-range
// change bumped the pipeline v2→v3 and re-extracts the whole corpus; this
// default moves in lockstep. ROLLOUT: flip only alongside (or after) that
// re-extraction - version-less reads return null for v3 until v3 rows exist.
const DEFAULT_SCHEMA_VERSION = "v3";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the estimated-current-total scan reads report_datapoints
 *  (ADR-0006 §4). Two years covers the current + prior reporting year - enough
 *  to anchor on the latest stock and sum the flows since - without scanning the
 *  entire back-catalogue on an all-time bucket read. */
const CURRENT_TOTAL_LOOKBACK_DAYS = 730;

/** Compute the four higher-tier windows a given `windowStart`
 *  belongs to. Used by the refresh mutation to enumerate all
 *  tiers a report contributes to.
 *
 *  weekly:  ISO Monday..Sunday containing the date
 *  monthly: 1st..last of the calendar month
 *  yearly:  Jan 1 .. Dec 31 of the calendar year
 *  all:     [epoch, +∞) - one bucket per country ever
 */
function weekOf(dt: Date): { start: Date; end: Date } {
  // ISO week - Monday is day 1, Sunday is day 7.
  const day = dt.getUTCDay() || 7; // Sunday → 7
  const start = new Date(dt);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (day - 1));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

function monthOf(dt: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0, 23, 59, 59, 999),
  );
  return { start, end };
}

function yearOf(dt: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const end = new Date(Date.UTC(dt.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
  return { start, end };
}

// Symbolic all-time window. Postgres accepts pre-epoch and far-future
// timestamps; using round numbers makes the rows visually obvious in
// the table.
const ALL_TIME_START = new Date("1970-01-01T00:00:00.000Z");
const ALL_TIME_END = new Date("9999-12-31T23:59:59.999Z");

interface BucketKey {
  windowStart: Date;
  windowEnd: Date;
  windowKind: "weekly" | "monthly" | "yearly" | "all";
  locationId: string | null;
}

function bucketKeyString(k: BucketKey): string {
  return `${k.windowKind}|${k.windowStart.toISOString()}|${k.windowEnd.toISOString()}|${k.locationId ?? "__null__"}`;
}

/** Resolve one location to its A0/A1/A2 ancestor chain. Used to
 *  attribute a report to the higher-tier buckets it contributes to. */
async function resolveLocationHierarchy(
  prisma: Context["prisma"],
  locationIds: string[],
): Promise<Map<string, { a2: string | null; a1: string | null; a0: string | null }>> {
  if (locationIds.length === 0) return new Map();
  const rows = await prisma.locations.findMany({
    where: { id: { in: locationIds } },
    select: { id: true, level: true, ancestorIds: true },
  });
  const ancestorIds = Array.from(
    new Set(rows.flatMap((r) => r.ancestorIds)),
  );
  const ancestorRows = ancestorIds.length
    ? await prisma.locations.findMany({
        where: { id: { in: ancestorIds } },
        select: { id: true, level: true },
      })
    : [];
  const levelById = new Map<string, number>();
  for (const r of rows) levelById.set(r.id, r.level);
  for (const r of ancestorRows) levelById.set(r.id, r.level);

  const result = new Map<string, { a2: string | null; a1: string | null; a0: string | null }>();
  for (const r of rows) {
    const chain: { a2: string | null; a1: string | null; a0: string | null } = {
      a2: null, a1: null, a0: null,
    };
    // Self may be A0/A1/A2 depending on level; ancestors fill the rest.
    if (r.level === 0) chain.a0 = r.id;
    if (r.level === 1) chain.a1 = r.id;
    if (r.level === 2) chain.a2 = r.id;
    for (const anc of r.ancestorIds) {
      const level = levelById.get(anc);
      if (level === 0 && !chain.a0) chain.a0 = anc;
      if (level === 1 && !chain.a1) chain.a1 = anc;
      if (level === 2 && !chain.a2) chain.a2 = anc;
    }
    result.set(r.id, chain);
  }
  return result;
}

/** Collect the distinct Figure-Scope location ids across a report's
 *  `data` blob - every `scope_location_id` a NumericField carries. These,
 *  not the report's mentioned `locationIds`, are what a figure is bucketed
 *  by (#273). A NumericField is a leaf, so we don't recurse into one. */
function collectFigureScopeIds(data: unknown, out: Set<string>): void {
  if (Array.isArray(data)) {
    for (const v of data) collectFigureScopeIds(v, out);
    return;
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (typeof o.scope_location_id === "string" && o.scope_location_id) {
      out.add(o.scope_location_id);
      return;
    }
    for (const v of Object.values(o)) collectFigureScopeIds(v, out);
  }
}

/** Turn a Prisma `reportDatapoint` row into the aggregator's
 *  `ReportRow` shape. Isolated so the aggregator stays decoupled
 *  from Prisma's model types. */
type PrismaReportDatapoint = Awaited<
  ReturnType<Context["prisma"]["reportDatapoint"]["findFirst"]>
>;

// The aggregator only reads these seven columns, so `toReportRow` accepts any
// row carrying them - a full row OR a `select`-narrowed one (the current-total
// path selects exactly these). Keeps the aggregator decoupled from Prisma.
type ReportRowFields = Pick<
  NonNullable<PrismaReportDatapoint>,
  | "reportId"
  | "publishedAt"
  | "reportingPeriodStart"
  | "reportingPeriodEnd"
  | "locationIds"
  | "data"
  | "sourceId"
>;

function toReportRow(row: ReportRowFields): ReportRow {
  return {
    reportId: row.reportId,
    publishedAt: row.publishedAt,
    reportingPeriodStart: row.reportingPeriodStart,
    reportingPeriodEnd: row.reportingPeriodEnd,
    locationIds: row.locationIds,
    data: row.data,
    sourceId: row.sourceId,
  };
}

/** Load the source-reliability registry into a `Map<sourceId → reliability>`
 *  for the aggregator. `data_sources` is a small table (dozens of rows), so
 *  one full load per aggregation run is cheaper than per-figure lookups. */
async function loadReliabilityBySource(
  prisma: Context["prisma"],
): Promise<Map<string, number | null>> {
  const sources = await prisma.dataSources.findMany({
    select: { id: true, reliability: true },
  });
  return new Map(sources.map((s) => [s.id, s.reliability]));
}

/** Build the org→reliability map the API adapters need, from the `data_sources`
 *  registry. Location-independent, so it's loaded once per aggregation run. */
async function loadApiReliabilityByOrg(prisma: Context["prisma"]) {
  const sources = await prisma.dataSources.findMany({
    select: { id: true, name: true, synonyms: true, reliability: true },
  });
  return buildApiReliabilityByOrg(sources);
}

/** Current (`validTo IS NULL`) reconciling-type `location_metadata` for one
 *  location → API mentions (ADR-0006). Empty for a null location. */
async function loadApiMentions(
  prisma: Context["prisma"],
  locationId: string | null,
  apiReliabilityByOrg: Awaited<ReturnType<typeof loadApiReliabilityByOrg>>,
) {
  if (!locationId) return buildApiMentions([], "", apiReliabilityByOrg);
  const rows = await prisma.locationMetadata.findMany({
    where: { locationId, validTo: null, type: { in: API_RECONCILING_TYPES } },
    select: { id: true, type: true, data: true, validFrom: true },
  });
  const lmRows: LocationMetadataRow[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    data: r.data,
    validFrom: r.validFrom,
  }));
  return buildApiMentions(lmRows, locationId, apiReliabilityByOrg);
}

/** Empty API-mention map, correctly typed (Mention is internal to the service). */
const EMPTY_API_MENTIONS: ReturnType<typeof buildApiMentions> = new Map();

/** Batch variant for the refresh path: current reconciling `location_metadata`
 *  for many locations in one query → `Map<locationId, apiMentionsByLabel>`, built
 *  once per location. Each bucket then window-filters its location's mentions. */
async function loadApiMentionsByLocation(
  prisma: Context["prisma"],
  locationIds: string[],
  apiReliabilityByOrg: Awaited<ReturnType<typeof loadApiReliabilityByOrg>>,
): Promise<Map<string, ReturnType<typeof buildApiMentions>>> {
  const map = new Map<string, ReturnType<typeof buildApiMentions>>();
  if (locationIds.length === 0) return map;
  const rows = await prisma.locationMetadata.findMany({
    where: { locationId: { in: locationIds }, validTo: null, type: { in: API_RECONCILING_TYPES } },
    select: { id: true, locationId: true, type: true, data: true, validFrom: true },
  });
  const byLoc = new Map<string, LocationMetadataRow[]>();
  for (const r of rows) {
    const list = byLoc.get(r.locationId) ?? [];
    list.push({ id: r.id, type: r.type, data: r.data, validFrom: r.validFrom });
    byLoc.set(r.locationId, list);
  }
  for (const [loc, lmRows] of byLoc) {
    map.set(loc, buildApiMentions(lmRows, loc, apiReliabilityByOrg));
  }
  return map;
}

export const datapointResolvers = {
  Query: {
    reportDatapoint: async (
      _parent: unknown,
      args: { reportId: string },
      context: Context,
    ) => {
      requireContentReader(context);
      return context.prisma.reportDatapoint.findUnique({
        where: { reportId: args.reportId },
      });
    },

    hasAggregatedDatapoints: async (
      _parent: unknown,
      args: { schemaVersion: string; countryLocationId?: string | null },
      context: Context,
    ): Promise<boolean> => {
      requireContentReader(context);
      // Only "current" rows (validTo IS NULL) count - a table full of
      // superseded history rows shouldn't fool the pipeline into
      // thinking it's already backfilled.
      let subtreeIds: string[] | null = null;
      if (args.countryLocationId) {
        // Per-country signal: a row anywhere in the country's SUBTREE, not only
        // at the admin-0 location. The four-tier walk keys yearly/all-time at
        // admin-0 but weekly/monthly at the reporting sub-locations with NO
        // ancestor roll-up, so a country reported only sub-nationally has no A0
        // row - matching on `locationId === countryLocationId` alone would read
        // it as never-aggregated and recompute the wide window every run (A123).
        // Resolve the country + its descendants and match any of them.
        const subtree = await context.prisma.locations.findMany({
          where: {
            OR: [
              { id: args.countryLocationId },
              { ancestorIds: { has: args.countryLocationId } },
            ],
          },
          select: { id: true },
        });
        if (subtree.length === 0) return false; // unresolvable id → treat as first-run
        subtreeIds = subtree.map((l) => l.id);
      }
      const row = await context.prisma.aggregatedDatapoint.findFirst({
        where: {
          schemaVersion: args.schemaVersion,
          validTo: null,
          ...(subtreeIds ? { locationId: { in: subtreeIds } } : {}),
        },
        select: { id: true },
      });
      return row !== null;
    },

    aggregatedDatapoint: async (
      _parent: unknown,
      args: {
        locationId?: string | null;
        windowStart: Date;
        windowEnd: Date;
        windowKind: string;
        schemaVersion?: string | null;
        asOf?: Date | null;
      },
      context: Context,
    ) => {
      requireContentReader(context);

      const schemaVersion = args.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
      const asOf = args.asOf ?? new Date();

      // ── Cache-first path ─────────────────────────────────────────
      // Returns the version whose validity window covers `asOf`.
      const cached = await context.prisma.aggregatedDatapoint.findFirst({
        where: {
          windowStart: args.windowStart,
          windowEnd: args.windowEnd,
          windowKind: args.windowKind,
          locationId: args.locationId ?? null,
          schemaVersion,
          validFrom: { lte: asOf },
          OR: [{ validTo: null }, { validTo: { gt: asOf } }],
        },
        orderBy: { validFrom: "desc" },
      });
      if (cached) {
        // Finalise data_quality with read-time Recency (clear-context-pipeline ADR-0005 §2): the cache
        // holds the time-invariant parts; freshness is scored live at `asOf`.
        const finalised = finaliseReadTimeQuality(
          (cached.data ?? {}) as Record<string, unknown>,
          asOf,
        );
        return {
          ...cached,
          data: finalised.data,
          // Legacy/pre-v2 buckets carry no per-field credibility envelope, so
          // `finaliseReadTimeQuality` finalises nothing and its score is a
          // meaningless 0. Keep the persisted score in that case rather than
          // overwriting a real value with 0 until a corpus refresh rewrites the
          // row in the new (0–10) shape. (#110)
          dataQualityScore:
            finalised.finalisedFieldCount > 0
              ? finalised.dataQualityScore
              : cached.dataQualityScore,
          onDemand: false,
        };
      }

      // ── On-demand fallback ────────────────────────────────────────
      // Pull the report_datapoints in this window and aggregate here.
      // Selection is by window only - NOT by the report's mentioned
      // `locationIds`. A report is relevant to `locationId` when a FIGURE
      // is scoped there, which needn't coincide with the places the report
      // names (#273); the aggregator's scope filter keeps only the figures
      // scoped to `locationId`, so a coarse window fetch + exact scope
      // filter is both correct and simpler than a JSON scope query.
      const rows = await context.prisma.reportDatapoint.findMany({
        where: {
          schemaVersion,
          reportingPeriodEnd: {
            gte: args.windowStart,
            lte: args.windowEnd,
          },
        },
      });
      // Authoritative location_metadata for this scope, gated to the window
      // (ADR-0006). Loaded even when there are no reports - the API figure can
      // gap-fill the bucket on its own.
      const apiOrgMap = await loadApiReliabilityByOrg(context.prisma);
      const apiMentions = filterApiMentionsToWindow(
        await loadApiMentions(context.prisma, args.locationId ?? null, apiOrgMap),
        args.windowStart,
        args.windowEnd,
      );
      if (rows.length === 0 && apiMentions.size === 0) return null;

      const reliabilityBySource = await loadReliabilityBySource(context.prisma);
      const result = aggregateReports(
        rows.map(toReportRow),
        args.locationId ?? null,
        reliabilityBySource,
        apiMentions,
      );
      if (!result) return null;

      // Finalise data_quality with read-time Recency, same as the cache path.
      const finalised = finaliseReadTimeQuality(
        result.data as Record<string, unknown>,
        asOf,
      );

      return {
        // Synthesised row - not persisted. `id` uses a stable synthetic
        // form so the dashboard can key its components consistently
        // across cache-hit and on-demand responses.
        id: `ondemand:${args.windowKind}:${args.windowStart.toISOString()}:${args.locationId ?? "country"}`,
        windowStart: args.windowStart,
        windowEnd: args.windowEnd,
        windowKind: args.windowKind,
        locationId: args.locationId ?? null,
        data: finalised.data,
        contributingReportIds: result.contributingReportIds,
        newestSourceAt: result.newestSourceAt,
        oldestSourceAt: result.oldestSourceAt,
        dataQualityScore: finalised.dataQualityScore,
        reportCount: result.reportCount,
        validFrom: new Date(),
        validTo: null,
        schemaVersion,
        computedAt: new Date(),
        onDemand: true,
      };
    },
  },

  ReportDatapoint: {
    // The report's publisher. Resolved lazily so a caller that only wants
    // titles doesn't pay for the join.
    //
    // One findUnique per report, so selecting `source` over a long list is
    // N+1. Fine at current call sizes (the situation-analysis dashboard
    // hydrates a few dozen cited reports at a time); batch through a
    // DataLoader before using it on an unbounded list.
    source: async (
      parent: { sourceId?: string | null },
      _args: unknown,
      context: Context,
    ) => {
      requireContentReader(context);
      // Null for v1 rows, which predate source attribution and were never
      // re-extracted. The client falls back to the sourceUrl host.
      if (!parent.sourceId) return null;
      return context.prisma.dataSources.findUnique({
        where: { id: parent.sourceId },
      });
    },
  },

  AggregatedDatapoint: {
    // Estimated current total (ADR-0006 §4): latest authoritative stock + flows
    // reported after its reference date T₀. Resolved lazily - the report scan
    // runs only when a client selects the field. Meaningful only at the
    // country (A0-scoped) yearly/all tier; every other bucket returns null.
    estimatedCurrentTotals: async (
      parent: {
        locationId?: string | null;
        windowKind?: string;
        windowEnd?: Date | string | null;
        schemaVersion?: string;
      },
      _args: unknown,
      context: Context,
    ) => {
      requireContentReader(context);
      if (!parent.locationId) return null;

      const asOf = new Date();
      // "Current" means as-of-now, so only attach the estimate to a bucket whose
      // window still includes now - a historical bucket (a past year, month or
      // week) must not carry a now-figure labelled as the period's number. The
      // `all` tier (far-future windowEnd) always qualifies. This is gated on the
      // window, NOT the window kind: the situation analysis consumes yearly AND
      // monthly buckets (and weekly is a valid current scope too).
      const windowEnd = parent.windowEnd ? new Date(parent.windowEnd) : null;
      if (windowEnd && windowEnd.getTime() < asOf.getTime()) return null;

      const schemaVersion = parent.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
      // Bounded lookback: a "current" estimate only needs the latest stock and
      // the flows after it - both recent - so cap the scan rather than reading
      // the whole back-catalogue. NOT free: like the on-demand path this fetches
      // by window only, since a figure's scope needn't be in the report's named
      // `locationIds` (#273), so a `locationIds` pre-filter would drop valid
      // figures. `select` keeps the payload to the columns the aggregator reads.
      const since = new Date(asOf.getTime() - CURRENT_TOTAL_LOOKBACK_DAYS * DAY_MS);
      const rows = await context.prisma.reportDatapoint.findMany({
        where: { schemaVersion, reportingPeriodEnd: { gte: since, lte: asOf } },
        select: {
          reportId: true,
          publishedAt: true,
          reportingPeriodStart: true,
          reportingPeriodEnd: true,
          locationIds: true,
          sourceId: true,
          data: true,
        },
      });
      // API stock (idp_stock / returnee_stock) is a current figure; asOf is now,
      // so the full current set is in-window - no window filter needed here.
      const apiOrgMap = await loadApiReliabilityByOrg(context.prisma);
      const apiMentions = await loadApiMentions(context.prisma, parent.locationId, apiOrgMap);
      const reliabilityBySource = await loadReliabilityBySource(context.prisma);
      const reportRows = rows.map(toReportRow);

      const totals: Record<string, unknown> = {};
      for (const pair of STOCK_FLOW_PAIRS) {
        totals[pair.metric] = estimateCurrentTotalFromRows(
          reportRows,
          apiMentions,
          parent.locationId,
          pair.stockLabel,
          pair.flowLabel,
          reliabilityBySource,
          asOf,
        );
      }
      return totals;
    },
  },

  Mutation: {
    upsertReportDatapoints: async (
      _parent: unknown,
      args: { input: UpsertReportDatapointsInput },
      context: Context,
    ): Promise<{
      reportId: string;
      schemaVersion: string;
      createdOrReplaced: boolean;
    }> => {
      requireRole(context, ["admin", "pipeline"]);
      const { input } = args;

      if (!input.reportId || !input.schemaVersion) {
        throw new GraphQLError(
          "upsertReportDatapoints: reportId and schemaVersion are required",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      // Idempotent replace-in-place - atomicity comes from the unique
      // constraint on `report_id`. Detect "was this a replace or a
      // new row" up front so the caller can log accurately (Prisma
      // upsert doesn't return that distinction).
      const existing = await context.prisma.reportDatapoint.findUnique({
        where: { reportId: input.reportId },
        select: { id: true },
      });

      const commonFields = {
        reportTitle: input.reportTitle,
        sourceUrl: input.sourceUrl,
        publishedAt: input.publishedAt,
        reportingPeriodStart: input.reportingPeriodStart ?? null,
        reportingPeriodEnd: input.reportingPeriodEnd ?? null,
        locationIds: input.locationIds,
        locationPcodes: input.locationPcodes,
        eventTypes: input.eventTypes,
        totalAffected: input.totalAffected ?? null,
        totalDisplaced: input.totalDisplaced ?? null,
        totalKilled: input.totalKilled ?? null,
        data: input.data,
        schemaVersion: input.schemaVersion,
        extractedByModel: input.extractedByModel,
        sourceId: input.sourceId ?? null,
      } as const;

      await context.prisma.reportDatapoint.upsert({
        where: { reportId: input.reportId },
        create: { reportId: input.reportId, ...commonFields },
        update: {
          ...commonFields,
          // `extractedAt` uses `@default(now())` but Prisma's update
          // path doesn't touch it unless we set it explicitly - we
          // want the fresh timestamp so the reviewer-audit workflow
          // can filter "extracted in the last N days" correctly.
          extractedAt: new Date(),
        },
      });

      return {
        reportId: input.reportId,
        schemaVersion: input.schemaVersion,
        createdOrReplaced: existing !== null,
      };
    },

    refreshAggregatedDatapoints: async (
      _parent: unknown,
      args: {
        from: Date;
        to: Date;
        schemaVersion: string;
        countryLocationId?: string | null;
      },
      context: Context,
    ): Promise<{
      computedBuckets: number;
      supersededBuckets: number;
      situationAnalysesInvalidated: number;
      schemaVersion: string;
    }> => {
      requireRole(context, ["admin", "pipeline"]);
      const { from, to, schemaVersion, countryLocationId } = args;

      // Validate the scope id up front (B123): a typo'd / unresolvable
      // countryLocationId matches no scope's admin-0 ancestor, so the refresh
      // would silently compute 0 buckets - indistinguishable from a real no-op.
      // Fail loudly instead so a caller bug surfaces rather than "did nothing".
      if (countryLocationId) {
        const country = await context.prisma.locations.findUnique({
          where: { id: countryLocationId },
          select: { id: true, level: true },
        });
        if (!country) {
          throw new GraphQLError(
            `refreshAggregatedDatapoints: countryLocationId '${countryLocationId}' is not a known location`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
      }

      // ── 1. Pull every report in the target window ────────────────
      const reports = await context.prisma.reportDatapoint.findMany({
        where: {
          schemaVersion,
          reportingPeriodEnd: { gte: from, lte: to },
        },
      });
      if (reports.length === 0) {
        return {
          computedBuckets: 0,
          supersededBuckets: 0,
          situationAnalysesInvalidated: 0,
          schemaVersion,
        };
      }

      // Source-reliability registry, loaded once for every bucket this refresh
      // recomputes (feeds each figure's data_quality via the aggregator).
      const reliabilityBySource = await loadReliabilityBySource(context.prisma);

      // ── 2. Collect every figure's scope, resolve its admin level ─
      // Buckets are keyed by FIGURE SCOPE now (#273), not by the places a
      // report merely mentions. A figure scoped to Kordofan belongs in
      // Kordofan's bucket and nowhere else - no roll-up into ancestors.
      // We resolve the hierarchy of the scope ids only to read each
      // scope's OWN admin level (its window tier); the chain returns the
      // id itself at its level, so `chain.aN === scopeId` identifies it.
      const scopeIdsByReport = new Map<string, string[]>();
      const allScopeIds = new Set<string>();
      for (const r of reports) {
        const set = new Set<string>();
        collectFigureScopeIds(r.data, set);
        scopeIdsByReport.set(r.reportId, [...set]);
        for (const id of set) allScopeIds.add(id);
      }
      const hierarchy = await resolveLocationHierarchy(
        context.prisma,
        [...allScopeIds],
      );

      // API contributors (ADR-0006): current location_metadata for every scope
      // location, built once and window-filtered per bucket below. (Buckets are
      // report-scoped, so a location with API data but no report figures is
      // reconciled on the on-demand read path, not pre-computed here.)
      const apiOrgMap = await loadApiReliabilityByOrg(context.prisma);
      const apiMentionsByLocation = await loadApiMentionsByLocation(
        context.prisma,
        [...allScopeIds],
        apiOrgMap,
      );

      // ── 3. Group reports into the four bucket tiers ──────────────
      // Bucket key strings dedupe transparently so a report tagged
      // with three A2s contributes to three weekly-A2 buckets but
      // only one monthly-A1 (per unique parent).
      const buckets = new Map<string, { key: BucketKey; rows: ReportRow[] }>();

      const push = (key: BucketKey, row: ReportRow) => {
        const k = bucketKeyString(key);
        const entry = buckets.get(k);
        if (entry) {
          if (!entry.rows.some((r) => r.reportId === row.reportId)) {
            entry.rows.push(row);
          }
        } else {
          buckets.set(k, { key, rows: [row] });
        }
      };

      for (const r of reports) {
        const row = toReportRow(r);
        // `reportingPeriodEnd` drives which window this report belongs
        // to across all four tiers - the same convention aggregators
        // use for incident dates in the atomic tier.
        const anchor = r.reportingPeriodEnd ?? r.publishedAt;
        const week = weekOf(anchor);
        const month = monthOf(anchor);
        const year = yearOf(anchor);

        // Route each of the report's figure scopes to ITS OWN bucket, at
        // the window tier for the scope's admin level - no roll-up. The
        // aggregator's scope filter then keeps only this report's figures
        // that are scoped to that location. Window tier by level: A0 →
        // yearly + monthly + all-time, A1 → monthly, A2 (or deeper) → weekly.
        // A0 also gets a monthly tier (alongside yearly) so the
        // situation-analysis pipeline can build a monthly country snapshot;
        // it aggregates only country-scoped figures, same as yearly-A0.
        for (const scopeId of scopeIdsByReport.get(r.reportId) ?? []) {
          const chain = hierarchy.get(scopeId);
          if (!chain) continue;
          // Country scoping: when a countryLocationId is given, only compute
          // buckets whose admin-0 ancestor IS that country, so a per-country
          // partition run recomputes only its own subtree (weekly-A2 through
          // all-time-A0) instead of a redundant global pass. `chain.a0` is the
          // scope's country ancestor (or the scope itself when it's admin-0).
          if (countryLocationId && chain.a0 !== countryLocationId) continue;
          if (chain.a0 === scopeId) {
            push({ windowStart: year.start, windowEnd: year.end, windowKind: "yearly", locationId: scopeId }, row);
            push({ windowStart: month.start, windowEnd: month.end, windowKind: "monthly", locationId: scopeId }, row);
            push({ windowStart: ALL_TIME_START, windowEnd: ALL_TIME_END, windowKind: "all", locationId: scopeId }, row);
          } else if (chain.a1 === scopeId) {
            push({ windowStart: month.start, windowEnd: month.end, windowKind: "monthly", locationId: scopeId }, row);
          } else {
            // A2 or deeper - atomic weekly tier at the scope itself.
            push({ windowStart: week.start, windowEnd: week.end, windowKind: "weekly", locationId: scopeId }, row);
          }
        }
      }

      // ── 4. For each bucket: compute → supersede previous → insert ─
      // One transaction per bucket keeps the "at most one current row"
      // invariant intact even under concurrent refreshes. Batching
      // would be faster but adds correctness risk we don't need for
      // POC scale.
      //
      // Cascade: when a yearly-country bucket is written, stamp
      // `validTo` on the corresponding `situation_analyses` current
      // row inside the same transaction - the situation analysis
      // depends transitively on that bucket, so writing a fresh
      // aggregation makes the situation snapshot stale by definition.
      // The next weekly Dagster regen picks up the invalidated row
      // and produces a fresh snapshot; between the two, the dashboard
      // gets no current row (empty-state UX). The cascade ignores
      // schema_version - situation_analyses versioning is independent
      // of aggregation versioning, and there is at most one current
      // row per schema version anyway.
      let computedBuckets = 0;
      let supersededBuckets = 0;
      let situationAnalysesInvalidated = 0;
      const now = new Date();

      for (const { key, rows } of buckets.values()) {
        const apiMentions = filterApiMentionsToWindow(
          (key.locationId && apiMentionsByLocation.get(key.locationId)) || EMPTY_API_MENTIONS,
          key.windowStart,
          key.windowEnd,
        );
        const agg = aggregateReports(rows, key.locationId, reliabilityBySource, apiMentions);
        if (!agg) continue;

        // Persist the finalised headline score (0–10, Recency folded in at
        // `now`) so the stored `data_quality_score` column matches what both
        // read paths serve. `aggregateReports` returns the pre-finalised
        // per-field mean (0–1); persisting that would leave the column an order
        // of magnitude off the API - and off any external reader of the column
        // (e.g. the Django app on this database). (#110). The `data` blob stays
        // pre-finalised on purpose; the read paths re-score Recency at read time.
        const persistedScore = finaliseReadTimeQuality(
          agg.data as Record<string, unknown>,
          now,
        ).dataQualityScore;

        await context.prisma.$transaction(async (tx) => {
          const superseded = await tx.aggregatedDatapoint.updateMany({
            where: {
              windowStart: key.windowStart,
              windowEnd: key.windowEnd,
              windowKind: key.windowKind,
              locationId: key.locationId,
              schemaVersion,
              validTo: null,
            },
            data: { validTo: now },
          });
          supersededBuckets += superseded.count;

          await tx.aggregatedDatapoint.create({
            data: {
              windowStart: key.windowStart,
              windowEnd: key.windowEnd,
              windowKind: key.windowKind,
              locationId: key.locationId,
              data: agg.data as Prisma.InputJsonValue,
              contributingReportIds: agg.contributingReportIds,
              newestSourceAt: agg.newestSourceAt,
              oldestSourceAt: agg.oldestSourceAt,
              dataQualityScore: persistedScore,
              reportCount: agg.reportCount,
              validFrom: now,
              schemaVersion,
            },
          });
          computedBuckets++;

          // Cascade invalidation to situation_analyses. The yearly-country
          // AND monthly-country tiers each drive a situation-analysis
          // snapshot, so a fresh bucket write at either tier makes the
          // matching snapshot stale. (weekly-A2 and monthly-A1 changes
          // don't - they roll up into a country bucket write handled here.
          // A monthly-A1 (state) bucket also reaches this branch but
          // no-ops: situation analyses are keyed by countryLocationId, so a
          // state locationId matches no row.) Match on
          // (countryLocationId, windowKind, windowStart) - the situation
          // bucket key. windowKind (not windowEnd) is deliberate: window
          // ends drift by a millisecond between this aggregator (.999) and
          // the pipeline's situation upsert (.000), so an end-based match
          // would silently invalidate nothing. windowStart is midnight-
          // aligned on both sides, so it matches exactly. A NULL locationId
          // (country-wide roll-up) has no materialised situation-analysis,
          // hence the `!= null` guard.
          if (
            (key.windowKind === "yearly" || key.windowKind === "monthly") &&
            key.locationId != null
          ) {
            const invalidated = await tx.situationAnalysis.updateMany({
              where: {
                countryLocationId: key.locationId,
                windowKind: key.windowKind,
                windowStart: key.windowStart,
                validTo: null,
              },
              data: { validTo: now },
            });
            situationAnalysesInvalidated += invalidated.count;
          }
        });
      }

      return {
        computedBuckets,
        supersededBuckets,
        situationAnalysesInvalidated,
        schemaVersion,
      };
    },
  },
};
