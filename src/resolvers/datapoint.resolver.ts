/**
 * Structured datapoint resolver — Layer 2 read path.
 *
 * Two entry points:
 *   - Query `reportDatapoint(reportId)` — per-report structured
 *     payload for the dashboard's provenance drill-down and the
 *     chatbot's "what did report X say?" path. Any authenticated
 *     content reader.
 *   - Mutation `upsertReportDatapoints(input)` — pipeline-only.
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
}

// Default schema version — matches the SCHEMA_VERSION constant in the
// Python-side extraction module. Keep in sync when bumping.
const DEFAULT_SCHEMA_VERSION = "v1";

/** Compute the four higher-tier windows a given `windowStart`
 *  belongs to. Used by the refresh mutation to enumerate all
 *  tiers a report contributes to.
 *
 *  weekly:  ISO Monday..Sunday containing the date
 *  monthly: 1st..last of the calendar month
 *  yearly:  Jan 1 .. Dec 31 of the calendar year
 *  all:     [epoch, +∞) — one bucket per country ever
 */
function weekOf(dt: Date): { start: Date; end: Date } {
  // ISO week — Monday is day 1, Sunday is day 7.
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
 *  `data` blob — every `scope_location_id` a NumericField carries. These,
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

function toReportRow(row: NonNullable<PrismaReportDatapoint>): ReportRow {
  return {
    reportId: row.reportId,
    publishedAt: row.publishedAt,
    reportingPeriodStart: row.reportingPeriodStart,
    reportingPeriodEnd: row.reportingPeriodEnd,
    locationIds: row.locationIds,
    data: row.data,
  };
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
      args: { schemaVersion: string },
      context: Context,
    ): Promise<boolean> => {
      requireContentReader(context);
      // Only "current" rows (validTo IS NULL) count — a table full of
      // superseded history rows shouldn't fool the pipeline into
      // thinking it's already backfilled.
      const row = await context.prisma.aggregatedDatapoint.findFirst({
        where: { schemaVersion: args.schemaVersion, validTo: null },
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
        return { ...cached, onDemand: false };
      }

      // ── On-demand fallback ────────────────────────────────────────
      // Pull the report_datapoints in this window and aggregate here.
      // Selection is by window only — NOT by the report's mentioned
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
      if (rows.length === 0) return null;

      const result = aggregateReports(
        rows.map(toReportRow),
        args.locationId ?? null,
      );
      if (!result) return null;

      return {
        // Synthesised row — not persisted. `id` uses a stable synthetic
        // form so the dashboard can key its components consistently
        // across cache-hit and on-demand responses.
        id: `ondemand:${args.windowKind}:${args.windowStart.toISOString()}:${args.locationId ?? "country"}`,
        windowStart: args.windowStart,
        windowEnd: args.windowEnd,
        windowKind: args.windowKind,
        locationId: args.locationId ?? null,
        data: result.data,
        contributingReportIds: result.contributingReportIds,
        newestSourceAt: result.newestSourceAt,
        oldestSourceAt: result.oldestSourceAt,
        dataQualityScore: result.dataQualityScore,
        reportCount: result.reportCount,
        validFrom: new Date(),
        validTo: null,
        schemaVersion,
        computedAt: new Date(),
        onDemand: true,
      };
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

      // Idempotent replace-in-place — atomicity comes from the unique
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
      } as const;

      await context.prisma.reportDatapoint.upsert({
        where: { reportId: input.reportId },
        create: { reportId: input.reportId, ...commonFields },
        update: {
          ...commonFields,
          // `extractedAt` uses `@default(now())` but Prisma's update
          // path doesn't touch it unless we set it explicitly — we
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
      args: { from: Date; to: Date; schemaVersion: string },
      context: Context,
    ): Promise<{
      computedBuckets: number;
      supersededBuckets: number;
      situationAnalysesInvalidated: number;
      schemaVersion: string;
    }> => {
      requireRole(context, ["admin", "pipeline"]);
      const { from, to, schemaVersion } = args;

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

      // ── 2. Collect every figure's scope, resolve its admin level ─
      // Buckets are keyed by FIGURE SCOPE now (#273), not by the places a
      // report merely mentions. A figure scoped to Kordofan belongs in
      // Kordofan's bucket and nowhere else — no roll-up into ancestors.
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
        // to across all four tiers — the same convention aggregators
        // use for incident dates in the atomic tier.
        const anchor = r.reportingPeriodEnd ?? r.publishedAt;
        const week = weekOf(anchor);
        const month = monthOf(anchor);
        const year = yearOf(anchor);

        // Route each of the report's figure scopes to ITS OWN bucket, at
        // the window tier for the scope's admin level — no roll-up. The
        // aggregator's scope filter then keeps only this report's figures
        // that are scoped to that location. Window tier by level: A0 →
        // yearly + all-time, A1 → monthly, A2 (or deeper) → weekly.
        for (const scopeId of scopeIdsByReport.get(r.reportId) ?? []) {
          const chain = hierarchy.get(scopeId);
          if (!chain) continue;
          if (chain.a0 === scopeId) {
            push({ windowStart: year.start, windowEnd: year.end, windowKind: "yearly", locationId: scopeId }, row);
            push({ windowStart: ALL_TIME_START, windowEnd: ALL_TIME_END, windowKind: "all", locationId: scopeId }, row);
          } else if (chain.a1 === scopeId) {
            push({ windowStart: month.start, windowEnd: month.end, windowKind: "monthly", locationId: scopeId }, row);
          } else {
            // A2 or deeper — atomic weekly tier at the scope itself.
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
      // row inside the same transaction — the situation analysis
      // depends transitively on that bucket, so writing a fresh
      // aggregation makes the situation snapshot stale by definition.
      // The next weekly Dagster regen picks up the invalidated row
      // and produces a fresh snapshot; between the two, the dashboard
      // gets no current row (empty-state UX). The cascade ignores
      // schema_version — situation_analyses versioning is independent
      // of aggregation versioning, and there is at most one current
      // row per schema version anyway.
      let computedBuckets = 0;
      let supersededBuckets = 0;
      let situationAnalysesInvalidated = 0;
      const now = new Date();

      for (const { key, rows } of buckets.values()) {
        const agg = aggregateReports(rows, key.locationId);
        if (!agg) continue;

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
              dataQualityScore: agg.dataQualityScore,
              reportCount: agg.reportCount,
              validFrom: now,
              schemaVersion,
            },
          });
          computedBuckets++;

          // Cascade invalidation to situation_analyses. Only the
          // yearly-country tier drives situation-analysis snapshots
          // (weekly-A2 and monthly-A1 changes don't invalidate the
          // yearly snapshot until they roll up into a fresh yearly
          // bucket write, which this branch handles). A NULL
          // locationId at this tier would mean a country-wide roll-up
          // whose situation-analysis we don't materialise today, so
          // the `!= null` guard is deliberate.
          if (key.windowKind === "yearly" && key.locationId != null) {
            const invalidated = await tx.situationAnalysis.updateMany({
              where: {
                countryLocationId: key.locationId,
                windowStart: key.windowStart,
                windowEnd: key.windowEnd,
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
