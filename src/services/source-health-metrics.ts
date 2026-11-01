/**
 * Source health (ADR-0017): whether each data feed CLEAR expects is still
 * delivering, read as the share of days a source was within its expected
 * cadence.
 *
 * `EXPECTED_CADENCE_DAYS` lists the feeds CLEAR expects and how often each
 * should deliver at least one ingested Signal. A source is **on schedule on a
 * UTC day** when it delivered an ingested Signal, by `collectedAt` (the
 * instant CLEAR received it), on that day or on one of the `cadence − 1` days
 * before it. A bucket's measure for a source is on-schedule days over days
 * measured, where the days measured are the bucket's days inside the range
 * that have ended before `now`: a day is judged once it is over. Ungrouped,
 * every expected source's days add up: the share of expected source-days met.
 *
 * Sources outside the list are not measured: the organisation rows that
 * report datapoints cite, the manual channels, and event-driven feeds such as
 * GDACS that are silent when nothing happens. The location filter does not
 * apply, since a feed delivers or it does not. The API returns counts only;
 * clear-mvp turns them into shares.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  bucketIndex,
  bucketsOf,
  resolveGranularity,
  resolveRange,
  startOfBucket,
  utcDay,
  type Bucket,
  type Granularity,
} from "./detection-metrics.js";
import { normaliseSourceNames } from "./location-precision-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The feeds CLEAR expects, by `dataSources.name`, and the most days that may
 * pass between two deliveries while the feed counts as on schedule. The
 * order is the order the series lists sources in. Revise it when a feed is
 * added, retired or changes its rhythm; the ADR records the reasoning.
 */
export const EXPECTED_CADENCE_DAYS: Readonly<Record<string, number>> = {
  dataminr: 1,
  "sudan-war-x": 1,
  darfur24: 1,
  acled: 7,
  idmc: 14,
  sudan_witness: 14,
  dtm: 31,
};

/** One day on which a source delivered at least one ingested Signal. */
export interface SourceDeliveryRow {
  source: string;
  /** Whole UTC days since the epoch of the delivery's `collectedAt`. */
  day: number;
}

/** One bucket of one source: how many of its measured days it was on schedule. */
export interface SourceHealthBucketRow extends Bucket {
  source: string;
  onScheduleDays: number;
  /** Days of this bucket inside the range that had ended before `now`. */
  days: number;
}

export interface SourceHealthMetrics {
  from: Date;
  to: Date;
  granularity: Granularity;
  /** The sources measured, in `EXPECTED_CADENCE_DAYS` order, with their cadence and totals over the range. */
  bySource: Array<{ source: string; cadenceDays: number; onScheduleDays: number; days: number }>;
  /** Source by bucket, zero-filled over every bucket the range touches, in `bySource` order then ascending. */
  series: SourceHealthBucketRow[];
}

export interface SourceHealthMetricsInput {
  from?: Date | string | null;
  to?: Date | string | null;
  /** Only these sources, by `dataSources.name`; names outside the expected list are ignored. */
  sourceNames?: string[] | null;
  /** Bucket size of `series`; defaults to WEEK. */
  granularity?: Granularity | null;
}

/** The expected sources to measure: the whole list, or the asked-for subset of it, in list order. */
export function expectedSources(sourceNames: string[] | null | undefined): Array<{ source: string; cadenceDays: number }> {
  const asked = new Set(normaliseSourceNames(sourceNames));
  return Object.entries(EXPECTED_CADENCE_DAYS)
    .filter(([source]) => asked.size === 0 || asked.has(source))
    .map(([source, cadenceDays]) => ({ source, cadenceDays }));
}

/** The measure over the delivery days, read at `granularity` (ADR-0014), judging only days that ended before `now`. */
export function summariseSourceHealth(
  rows: SourceDeliveryRow[],
  range: { from: Date; to: Date },
  sources: Array<{ source: string; cadenceDays: number }>,
  granularity: Granularity = "WEEK",
  now: Date = new Date(),
): SourceHealthMetrics {
  const delivered = new Map<string, Set<number>>();
  for (const row of rows) {
    let days = delivered.get(row.source);
    if (!days) delivered.set(row.source, (days = new Set()));
    days.add(row.day);
  }
  const buckets = bucketsOf(range, granularity);
  const index = bucketIndex(buckets);
  const firstDay = utcDay(range.from);
  const lastDay = Math.min(utcDay(range.to), utcDay(now) - 1);
  const bySource: SourceHealthMetrics["bySource"] = [];
  const series: SourceHealthBucketRow[] = [];
  for (const { source, cadenceDays } of sources) {
    const rowsOfSource: SourceHealthBucketRow[] = buckets.map((bucket) => ({ ...bucket, source, onScheduleDays: 0, days: 0 }));
    const deliveredDays = delivered.get(source) ?? new Set<number>();
    let onScheduleDays = 0;
    let days = 0;
    for (let day = firstDay; day <= lastDay; day++) {
      const i = index.get(startOfBucket(new Date(day * DAY_MS), granularity).getTime());
      if (i === undefined) continue;
      let onSchedule = false;
      for (let d = day; d > day - cadenceDays && !onSchedule; d--) onSchedule = deliveredDays.has(d);
      const cell = rowsOfSource[i]!;
      cell.days++;
      days++;
      if (onSchedule) {
        cell.onScheduleDays++;
        onScheduleDays++;
      }
    }
    bySource.push({ source, cadenceDays, onScheduleDays, days });
    series.push(...rowsOfSource);
  }
  return { from: range.from, to: range.to, granularity, bySource, series };
}

/**
 * The days on which each expected source delivered an ingested Signal, from
 * the longest cadence before the range (so a delivery just before it counts
 * for its first days) to the range's end. Ingested means what time to
 * detection means: not an accepted web case, not filed by hand, not
 * retracted, not dummy.
 */
export async function fetchSourceDeliveryRows(
  prisma: PrismaClient,
  range: { from: Date; to: Date },
  sources: Array<{ source: string; cadenceDays: number }>,
): Promise<SourceDeliveryRow[]> {
  if (sources.length === 0) return [];
  const lookback = Math.max(...sources.map((s) => s.cadenceDays)) - 1;
  const from = new Date(utcDay(range.from) * DAY_MS - lookback * DAY_MS);
  return prisma.$queryRaw<SourceDeliveryRow[]>`
    SELECT ds."name" AS "source", FLOOR(EXTRACT(EPOCH FROM s."collected_at") / 86400)::int AS "day"
    FROM "signals" s
    JOIN "data_sources" ds ON ds."id" = s."source_id"
    WHERE ds."name" IN (${Prisma.join(sources.map((s) => s.source))})
      AND s."collected_at" >= ${from}
      AND s."collected_at" <= ${range.to}
      AND s."submitted_by_id" IS NULL
      AND s."raw_data"->>'manual' IS DISTINCT FROM 'true'
      AND NOT s."retracted"
      AND NOT s."isDummy"
    GROUP BY 1, 2
  `;
}

/** Source health over the requested range and sources. */
export async function computeSourceHealthMetrics(
  prisma: PrismaClient,
  input: SourceHealthMetricsInput,
  now: Date = new Date(),
): Promise<SourceHealthMetrics> {
  const range = resolveRange(input, now);
  const granularity = resolveGranularity(input.granularity);
  const sources = expectedSources(input.sourceNames);
  const rows = await fetchSourceDeliveryRows(prisma, range, sources);
  return summariseSourceHealth(rows, range, sources, granularity, now);
}
