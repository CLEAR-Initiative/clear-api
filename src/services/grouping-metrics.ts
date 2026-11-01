/**
 * Grouping proxies (ADR-0018): how much of what CLEAR ingests finds company
 * in an Event. Nobody records yet whether an Event was split or merged in
 * error (Exponential #1268), so two proxies stand in, named as proxies:
 *
 * - **Signals grouped**: the share of ingested Signals whose Event holds at
 *   least one other ingested Signal, out of every ingested Signal that has
 *   been through grouping (linked to an Event), by the Signal's `publishedAt`
 *   and its source.
 * - **Events with one Signal**: the share of Events holding exactly one
 *   ingested Signal, out of every Event with an ingested Signal in range, by
 *   the Event's first ingested Signal and that Signal's source.
 *
 * A high grouped share can mean good merging or over-merging; a high
 * single-Signal share can mean under-merging or many isolated reports. Read
 * them beside the correctness sample when one exists. Ingested means what
 * time to detection means: not an accepted web case, not filed by hand, not
 * retracted, not dummy. The API returns counts only.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  bucketIndex,
  bucketsOf,
  eventsInLocation,
  ingestedSignal,
  normaliseSourceNames,
  resolveGranularity,
  resolveRange,
  startOfBucket,
  type Bucket,
  type Granularity,
} from "./detection-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One UTC day of one source: how many rows, and how many of them meet the metric. */
export interface SourceDayRow {
  source: string;
  /** Whole UTC days since the epoch. */
  day: number;
  numerator: number;
  denominator: number;
}

/** One bucket of one source. */
export interface SourceShareRow extends Bucket {
  source: string;
  numerator: number;
  denominator: number;
}

/** A share per source per bucket, the shape both grouping proxies share. */
export interface SourceShareMetrics {
  from: Date;
  to: Date;
  granularity: Granularity;
  /** Sources with a row in range, most rows first, with their totals. */
  bySource: Array<{ source: string; numerator: number; denominator: number }>;
  /** Source by bucket, zero-filled over every bucket the range touches, in `bySource` order then ascending. */
  series: SourceShareRow[];
}

export interface GroupingMetricsInput {
  from?: Date | string | null;
  to?: Date | string | null;
  locationId?: string | null;
  /** Only these sources, by `dataSources.name`. */
  sourceNames?: string[] | null;
  /** Bucket size of `series`; defaults to WEEK. */
  granularity?: Granularity | null;
}

/** The day rows folded into buckets of `granularity` per source, sources ordered by their total, most first. */
export function foldSourceDays(rows: SourceDayRow[], range: { from: Date; to: Date }, granularity: Granularity = "WEEK"): SourceShareMetrics {
  const buckets = bucketsOf(range, granularity);
  const index = bucketIndex(buckets);
  const totals = new Map<string, { numerator: number; denominator: number; cells: SourceShareRow[] }>();
  for (const row of rows) {
    let entry = totals.get(row.source);
    if (!entry) {
      entry = { numerator: 0, denominator: 0, cells: buckets.map((bucket) => ({ ...bucket, source: row.source, numerator: 0, denominator: 0 })) };
      totals.set(row.source, entry);
    }
    entry.numerator += row.numerator;
    entry.denominator += row.denominator;
    const i = index.get(startOfBucket(new Date(row.day * DAY_MS), granularity).getTime());
    if (i === undefined) continue;
    entry.cells[i]!.numerator += row.numerator;
    entry.cells[i]!.denominator += row.denominator;
  }
  const bySource = [...totals.entries()]
    .map(([source, { numerator, denominator }]) => ({ source, numerator, denominator }))
    .sort((a, b) => b.denominator - a.denominator || a.source.localeCompare(b.source));
  return {
    from: range.from,
    to: range.to,
    granularity,
    bySource,
    series: bySource.flatMap(({ source }) => totals.get(source)!.cells),
  };
}

/** The `WHERE` clause that keeps the Signals (aliased `s`) whose location is `locationId` or inside it. */
function signalsInLocation(locationId: string | null): Prisma.Sql {
  return locationId
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM "locations" l
        WHERE l."id" = COALESCE(s."location_id", s."origin_id", s."destination_id")
          AND (l."id" = ${locationId} OR ${locationId} = ANY(l."ancestor_ids"))
      )`
    : Prisma.empty;
}

const inSources = (sourceNames: string[], column: Prisma.Sql) =>
  sourceNames.length > 0 ? Prisma.sql`AND ${column} IN (${Prisma.join(sourceNames)})` : Prisma.empty;

/**
 * Ingested Signals that have been through grouping, by source and UTC day
 * of `publishedAt`, with how many share their Event with another ingested
 * Signal.
 */
export async function fetchGroupedSignalRows(
  prisma: PrismaClient,
  range: { from: Date; to: Date },
  locationId: string | null,
  sourceNames: string[],
): Promise<SourceDayRow[]> {
  return prisma.$queryRaw<SourceDayRow[]>`
    SELECT ds."name" AS "source",
      FLOOR(EXTRACT(EPOCH FROM s."published_at") / 86400)::int AS "day",
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "signal_to_events" se
        JOIN "signal_to_events" se2 ON se2."event_id" = se."event_id" AND se2."signal_id" <> se."signal_id"
        JOIN "signals" o ON o."id" = se2."signal_id" AND ${ingestedSignal("o")}
        WHERE se."signal_id" = s."id"
      ))::int AS "numerator",
      COUNT(*)::int AS "denominator"
    FROM "signals" s
    JOIN "data_sources" ds ON ds."id" = s."source_id"
    WHERE ${ingestedSignal("s")}
      AND s."published_at" >= ${range.from}
      AND s."published_at" <= ${range.to}
      AND EXISTS (SELECT 1 FROM "signal_to_events" se0 WHERE se0."signal_id" = s."id")
      ${inSources(sourceNames, Prisma.raw('ds."name"'))}
      ${signalsInLocation(locationId)}
    GROUP BY 1, 2
  `;
}

/**
 * Events with an ingested Signal, by the source and UTC day of their first
 * ingested Signal, with how many hold exactly one.
 */
export async function fetchSingleSignalEventRows(
  prisma: PrismaClient,
  range: { from: Date; to: Date },
  locationId: string | null,
  sourceNames: string[],
): Promise<SourceDayRow[]> {
  return prisma.$queryRaw<SourceDayRow[]>`
    WITH first_ingested AS (
      SELECT se."event_id", MIN(s."published_at") AS "at", COUNT(*)::int AS "n"
      FROM "signal_to_events" se
      JOIN "signals" s ON s."id" = se."signal_id"
      WHERE ${ingestedSignal("s")}
      GROUP BY se."event_id"
    ),
    first_source AS (
      SELECT DISTINCT ON (se."event_id") se."event_id", ds."name" AS "source"
      FROM "signal_to_events" se
      JOIN "signals" s ON s."id" = se."signal_id"
      JOIN "data_sources" ds ON ds."id" = s."source_id"
      WHERE ${ingestedSignal("s")}
      ORDER BY se."event_id", s."published_at" ASC, s."id" ASC
    )
    SELECT fs."source",
      FLOOR(EXTRACT(EPOCH FROM fi."at") / 86400)::int AS "day",
      COUNT(*) FILTER (WHERE fi."n" = 1)::int AS "numerator",
      COUNT(*)::int AS "denominator"
    FROM "events" e
    JOIN first_ingested fi ON fi."event_id" = e."id"
    JOIN first_source fs ON fs."event_id" = e."id"
    WHERE NOT e."isDummy"
      AND fi."at" >= ${range.from}
      AND fi."at" <= ${range.to}
      ${inSources(sourceNames, Prisma.raw('fs."source"'))}
      ${eventsInLocation(locationId)}
    GROUP BY 1, 2
  `;
}

/** Signals grouped over the requested range, location and sources. */
export async function computeSignalsGrouped(prisma: PrismaClient, input: GroupingMetricsInput, now: Date = new Date()): Promise<SourceShareMetrics> {
  const range = resolveRange(input, now);
  const granularity = resolveGranularity(input.granularity);
  const rows = await fetchGroupedSignalRows(prisma, range, input.locationId || null, normaliseSourceNames(input.sourceNames));
  return foldSourceDays(rows, range, granularity);
}

/** Events with one Signal over the requested range, location and sources. */
export async function computeSingleSignalEvents(prisma: PrismaClient, input: GroupingMetricsInput, now: Date = new Date()): Promise<SourceShareMetrics> {
  const range = resolveRange(input, now);
  const granularity = resolveGranularity(input.granularity);
  const rows = await fetchSingleSignalEventRows(prisma, range, input.locationId || null, normaliseSourceNames(input.sourceNames));
  return foldSourceDays(rows, range, granularity);
}
