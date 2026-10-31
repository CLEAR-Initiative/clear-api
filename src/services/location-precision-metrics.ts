/**
 * Location precision (ADR-0012): how finely CLEAR placed the Signals it
 * ingested, per source and ISO week. Grouping keys on district, so a Signal
 * left at state or country level always becomes its own Event; this metric
 * is how a geocoding change is judged.
 *
 * Each ingested Signal in range is counted once, under the level of its
 * location: `noLocation`, `country` (0), `state` (1), `district` (2) or
 * `point` (a level-4 landmark or coordinate point; there is no level 3).
 * "District or finer" is `district + point`. The location is the Signal's
 * general location, or for a displacement Signal its origin (where the
 * incident happened), else its destination. A Signal a person corrected (an
 * accepted or corrected Location challenge) is read at the location the
 * pipeline gave it, the first applied challenge's `previousLocationId`, not
 * the point the person wrote.
 *
 * A Signal is **in range** by the instant it was last located: `processedAt`
 * (the drain that resolves text-only sources sets it) or, with none,
 * `collectedAt` (sources with coordinates are placed on arrival). That is the
 * week a pipeline deploy shows up in, which is the point of the metric; it
 * differs from time to detection, which buckets by `publishedAt`.
 *
 * **Ingested** means the same as in ADR-0011: brought in by a pipeline (no
 * `submittedById`, not `rawData.manual`), not retracted, not dummy. Signals a
 * person placed by hand would measure the person, not the pipeline.
 *
 * `corrections` counts Location challenges filed in the range by status, a
 * correctness proxy until an analyst-checked sample exists. The API returns
 * counts only; clear-mvp turns them into shares.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { isoWeekLabel, resolveRange, startOfIsoWeek } from "./detection-metrics.js";

export const LEVELS = ["noLocation", "country", "state", "district", "point"] as const;
export type Level = (typeof LEVELS)[number];

export const CORRECTION_STATUSES = ["open", "accepted", "corrected", "declined", "superseded"] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** One (source, UTC day, level) cell, as the query aggregates Signals. */
export interface LocationPrecisionRow {
  /** `dataSources.name`, e.g. `sudan-war-x`. */
  source: string;
  /** Whole UTC days since the epoch of the instant the Signals were located. */
  day: number;
  /** `locations.level` of their location; null when they have none. */
  level: number | null;
  count: number;
}

/** One (challenge status, count) cell. */
export interface LocationCorrectionRow {
  status: string;
  count: number;
}

export interface LevelCounts {
  total: number;
  noLocation: number;
  country: number;
  state: number;
  district: number;
  point: number;
}

export interface LocationPrecisionMetrics {
  from: Date;
  to: Date;
  signalsInRange: number;
  /** One row per source with a Signal in range, most Signals first. */
  bySource: Array<{ source: string } & LevelCounts>;
  /** Source by ISO week, zero-filled over every week the range touches, in `bySource` order then ascending weeks. */
  weekly: Array<{ isoWeek: string; weekStart: Date; source: string; isPartial: boolean } & LevelCounts>;
  corrections: Record<CorrectionStatus, number>;
}

export interface LocationPrecisionMetricsInput {
  from?: Date | string | null;
  to?: Date | string | null;
  locationId?: string | null;
  sourceNames?: string[] | null;
}

/** The bucket a location level falls in; anything finer than a district is a point. */
export function levelBucket(level: number | null | undefined): Level {
  if (level == null || level < 0) return "noLocation";
  if (level === 0) return "country";
  if (level === 1) return "state";
  if (level === 2) return "district";
  return "point";
}

/** The bucket a Location challenge status counts under; null for a status the metric does not know. */
export function correctionBucket(status: string): CorrectionStatus | null {
  if (status === "consideration") return "open";
  return (CORRECTION_STATUSES as readonly string[]).includes(status) ? (status as CorrectionStatus) : null;
}

function emptyCounts(): LevelCounts {
  return { total: 0, noLocation: 0, country: 0, state: 0, district: 0, point: 0 };
}

/** The metric over the aggregated cells. Pure, so the shape is unit-tested without a database. */
export function summarise(
  rows: LocationPrecisionRow[],
  corrections: LocationCorrectionRow[],
  range: { from: Date; to: Date },
): LocationPrecisionMetrics {
  const weeks: Array<{ start: number; isoWeek: string; isPartial: boolean }> = [];
  const weekIndex = new Map<number, number>();
  const lastWeek = startOfIsoWeek(range.to).getTime();
  for (let start = startOfIsoWeek(range.from).getTime(); start <= lastWeek; start += WEEK_MS) {
    weekIndex.set(start, weeks.length);
    weeks.push({
      start,
      isoWeek: isoWeekLabel(new Date(start)),
      // `to` is inclusive, so a range ending at Sunday 23:59:59.999 covers its week.
      isPartial: start < range.from.getTime() || start + WEEK_MS > range.to.getTime() + 1,
    });
  }

  const totals = new Map<string, LevelCounts>();
  const perWeek = new Map<string, LevelCounts[]>();
  let signalsInRange = 0;
  for (const row of rows) {
    const n = Number(row.count) || 0;
    if (n <= 0) continue;
    const bucket = levelBucket(row.level);
    let total = totals.get(row.source);
    if (!total) {
      total = emptyCounts();
      totals.set(row.source, total);
      perWeek.set(
        row.source,
        weeks.map(() => emptyCounts()),
      );
    }
    total.total += n;
    total[bucket] += n;
    signalsInRange += n;
    const i = weekIndex.get(startOfIsoWeek(new Date(row.day * DAY_MS)).getTime());
    if (i !== undefined) {
      const week = perWeek.get(row.source)![i]!;
      week.total += n;
      week[bucket] += n;
    }
  }

  const bySource = [...totals.entries()]
    .map(([source, counts]) => ({ source, ...counts }))
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));

  const weekly: LocationPrecisionMetrics["weekly"] = [];
  for (const { source } of bySource) {
    const counts = perWeek.get(source)!;
    weeks.forEach((week, i) => {
      weekly.push({
        isoWeek: week.isoWeek,
        weekStart: new Date(week.start),
        source,
        isPartial: week.isPartial,
        ...counts[i]!,
      });
    });
  }

  const correctionCounts = Object.fromEntries(CORRECTION_STATUSES.map((s) => [s, 0])) as Record<CorrectionStatus, number>;
  for (const row of corrections) {
    const bucket = correctionBucket(row.status);
    if (bucket) correctionCounts[bucket] += Number(row.count) || 0;
  }

  return { from: range.from, to: range.to, signalsInRange, bySource, weekly, corrections: correctionCounts };
}

/**
 * The location the pipeline gave the Signal `s`: its own location fields, or,
 * once a person corrected it, the location the first applied Location
 * challenge recorded when it was filed. A human point would measure the
 * person, not the pipeline, and lift the Signal's original week.
 */
const PIPELINE_LOCATION = Prisma.sql`CASE
  WHEN s."location_corrected_at" IS NULL THEN COALESCE(s."location_id", s."origin_id", s."destination_id")
  ELSE (
    SELECT c0."previous_location_id" FROM "signal_location_challenges" c0
    WHERE c0."signal_id" = s."id" AND c0."status" IN ('accepted', 'corrected')
    ORDER BY c0."decided_at" ASC NULLS LAST, c0."created_at" ASC
    LIMIT 1
  )
END`;

/** `WHERE` clauses shared by both queries: the Signal's source and location. */
function filters(locationId: string | null, sourceNames: string[]) {
  const inSources = sourceNames.length > 0 ? Prisma.sql`AND ds."name" IN (${Prisma.join(sourceNames)})` : Prisma.empty;
  // A Signal with no location cannot be placed in or out of a location, so
  // the location filter leaves it out; `noLocation` is only measured globally.
  const inLocation = locationId
    ? Prisma.sql`AND (l."id" = ${locationId} OR ${locationId} = ANY(l."ancestor_ids"))`
    : Prisma.empty;
  return { inSources, inLocation };
}

/**
 * Ingested Signals in range, aggregated by source, UTC day of the instant
 * they were located, and the level of their location. The day is whole days
 * since the epoch, computed on the stored UTC timestamp so no session time
 * zone can shift it.
 */
export async function fetchLocationPrecisionRows(
  prisma: PrismaClient,
  range: { from: Date; to: Date },
  locationId: string | null,
  sourceNames: string[],
): Promise<LocationPrecisionRow[]> {
  const { inSources, inLocation } = filters(locationId, sourceNames);
  return prisma.$queryRaw<LocationPrecisionRow[]>`
    SELECT ds."name" AS "source",
      FLOOR(EXTRACT(EPOCH FROM COALESCE(s."processed_at", s."collected_at")) / 86400)::int AS "day",
      l."level" AS "level",
      COUNT(*)::int AS "count"
    FROM "signals" s
    JOIN "data_sources" ds ON ds."id" = s."source_id"
    LEFT JOIN "locations" l ON l."id" = ${PIPELINE_LOCATION}
    WHERE s."submitted_by_id" IS NULL
      AND s."raw_data"->>'manual' IS DISTINCT FROM 'true'
      AND NOT s."retracted"
      AND NOT s."isDummy"
      AND COALESCE(s."processed_at", s."collected_at") >= ${range.from}
      AND COALESCE(s."processed_at", s."collected_at") <= ${range.to}
      ${inSources}
      ${inLocation}
    GROUP BY 1, 2, 3
  `;
}

/** Location challenges filed in range, by status, under the same source and location filters. */
export async function fetchLocationCorrectionRows(
  prisma: PrismaClient,
  range: { from: Date; to: Date },
  locationId: string | null,
  sourceNames: string[],
): Promise<LocationCorrectionRow[]> {
  const { inSources, inLocation } = filters(locationId, sourceNames);
  return prisma.$queryRaw<LocationCorrectionRow[]>`
    SELECT c."status" AS "status", COUNT(*)::int AS "count"
    FROM "signal_location_challenges" c
    JOIN "signals" s ON s."id" = c."signal_id"
    JOIN "data_sources" ds ON ds."id" = s."source_id"
    LEFT JOIN "locations" l ON l."id" = ${PIPELINE_LOCATION}
    WHERE c."created_at" >= ${range.from}
      AND c."created_at" <= ${range.to}
      ${inSources}
      ${inLocation}
    GROUP BY 1
  `;
}

/** Source names as the query uses them: trimmed, non-empty, unique. */
export function normaliseSourceNames(sourceNames: string[] | null | undefined): string[] {
  return [...new Set((sourceNames ?? []).map((name) => name.trim()).filter(Boolean))];
}

/** Location precision over the requested range, location and sources. */
export async function computeLocationPrecisionMetrics(
  prisma: PrismaClient,
  input: LocationPrecisionMetricsInput,
  now: Date = new Date(),
): Promise<LocationPrecisionMetrics> {
  const range = resolveRange({ from: input.from, to: input.to }, now);
  const locationId = input.locationId || null;
  const sourceNames = normaliseSourceNames(input.sourceNames);
  const rows = await fetchLocationPrecisionRows(prisma, range, locationId, sourceNames);
  const corrections = await fetchLocationCorrectionRows(prisma, range, locationId, sourceNames);
  return summarise(rows, corrections, range);
}
