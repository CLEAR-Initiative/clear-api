/**
 * Detection recall proxy (ADR-0018): of the events a reference dataset
 * recorded, how many did CLEAR raise an Alert for from its other feeds?
 *
 * ACLED stands in for ground truth: each of its Signals is one ACLED event,
 * dated by `publishedAt` (the event date at 00:00 UTC) and placed at a point
 * under a district. An ACLED event counts as **alerted nearby** when its
 * district held a CLEAR Alert whose Event is dated within `RECALL_WINDOW_DAYS`
 * UTC days either side of the ACLED date and holds at least one ingested
 * Signal from a source other than ACLED, so that only what CLEAR found on its
 * own counts. An Event is dated by its onset when that is day-precise, else
 * by its first Signal, as the sibling metrics refuse to do day arithmetic on
 * a week- or month-precise onset; it is in a district when any of its places
 * (general location, origin, destination) is in it, as every Event metric
 * reads places. An ACLED event with no district cannot be matched and counts
 * as not alerted; under a location filter it is not in the location at all.
 * Retracted and dummy Signals take no part. The newest `RECALL_WINDOW_DAYS`
 * cannot yet hold their Alerts, and ACLED releases weekly, so the newest week
 * reads low until both catch up. The API returns counts only.
 *
 * The query makes one pass over the alerted Events in the window, expands
 * each into the (district, day) pairs it covers, and joins the ACLED events
 * to that set on equality, which Postgres hashes: 0.2 s for twelve weeks on
 * dev. A correlated test against the same set was re-run per ACLED row (24 s
 * inlined, 3.4 s materialised), so the match is a join, not a sub-select.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import {
  bucketIndex,
  bucketsOf,
  ingestedSignal,
  resolveGranularity,
  resolveRange,
  signalsInLocation,
  startOfBucket,
  type Bucket,
  type DetectionMetricsInput,
  type Granularity,
} from "./detection-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The `dataSources.name` of the reference dataset. */
export const GROUND_TRUTH_SOURCE = "acled";
/** Days either side of the reference event's date within which a CLEAR Alert counts. */
export const RECALL_WINDOW_DAYS = 3;

/** One UTC day of reference events: how many, and how many were alerted nearby. */
export interface RecallDayRow {
  day: number;
  groundTruth: number;
  alerted: number;
}

export interface RecallBucketRow extends Bucket {
  groundTruth: number;
  alerted: number;
}

export interface RecallMetrics {
  from: Date;
  to: Date;
  granularity: Granularity;
  groundTruth: number;
  alerted: number;
  /** Zero-filled over every bucket the range touches, ascending. */
  series: RecallBucketRow[];
}

/** The same range, location and bucket size as time to detection. */
export type RecallMetricsInput = DetectionMetricsInput;

/** The day rows folded into buckets of `granularity` (ADR-0014). */
export function summariseRecall(rows: RecallDayRow[], range: { from: Date; to: Date }, granularity: Granularity = "WEEK"): RecallMetrics {
  const buckets = bucketsOf(range, granularity);
  const index = bucketIndex(buckets);
  const series: RecallBucketRow[] = buckets.map((bucket) => ({ ...bucket, groundTruth: 0, alerted: 0 }));
  let groundTruth = 0;
  let alerted = 0;
  for (const row of rows) {
    groundTruth += row.groundTruth;
    alerted += row.alerted;
    const i = index.get(startOfBucket(new Date(row.day * DAY_MS), granularity).getTime());
    if (i === undefined) continue;
    series[i]!.groundTruth += row.groundTruth;
    series[i]!.alerted += row.alerted;
  }
  return { from: range.from, to: range.to, granularity, groundTruth, alerted, series };
}

/**
 * The reference source's Signals in range by UTC day, with how many had a
 * CLEAR Alert from another feed in their district within the window.
 * `source` and `windowDays` are parameters so a test can bring its own
 * reference feed; the metric uses the constants.
 */
export async function fetchRecallRows(
  prisma: PrismaClient,
  range: { from: Date; to: Date },
  locationId: string | null,
  source: string = GROUND_TRUTH_SOURCE,
  windowDays: number = RECALL_WINDOW_DAYS,
): Promise<RecallDayRow[]> {
  // The alerted Events worth reading: dated within the window of any reference day in range, with a day's slack for the day arithmetic.
  const since = new Date(range.from.getTime() - (windowDays + 1) * DAY_MS);
  const until = new Date(range.to.getTime() + (windowDays + 1) * DAY_MS);
  return prisma.$queryRaw<RecallDayRow[]>`
    WITH reference AS (
      SELECT FLOOR(EXTRACT(EPOCH FROM s."published_at") / 86400)::int AS "day",
        CASE WHEN l."level" = 2 THEN l."id"
          ELSE (SELECT l2."id" FROM "locations" l2 WHERE l2."level" = 2 AND l2."id" = ANY(l."ancestor_ids") LIMIT 1)
        END AS "district"
      FROM "signals" s
      JOIN "data_sources" ds ON ds."id" = s."source_id" AND ds."name" = ${source}
      LEFT JOIN "locations" l ON l."id" = COALESCE(s."location_id", s."origin_id", s."destination_id")
      WHERE NOT s."retracted"
        AND NOT s."isDummy"
        AND s."published_at" >= ${range.from}
        AND s."published_at" <= ${range.to}
        ${signalsInLocation(locationId)}
    ),
    alerted AS (
      SELECT DISTINCT
        CASE WHEN el."level" = 2 THEN el."id"
          ELSE (SELECT l2."id" FROM "locations" l2 WHERE l2."level" = 2 AND l2."id" = ANY(el."ancestor_ids") LIMIT 1)
        END AS "district",
        FLOOR(EXTRACT(EPOCH FROM COALESCE(
          CASE WHEN e."started_at_accuracy" IS NULL OR e."started_at_accuracy" = 'DAY' THEN e."started_at" END,
          e."first_signal_created_at")) / 86400)::int + g."offset" AS "day"
      FROM "alerts" al
      JOIN "events" e ON e."id" = al."event_id"
      CROSS JOIN LATERAL (VALUES (e."location_id"), (e."origin_id"), (e."destination_id")) AS p("place_id")
      JOIN "locations" el ON el."id" = p."place_id"
      CROSS JOIN generate_series(${-windowDays}::int, ${windowDays}::int) AS g("offset")
      WHERE NOT e."isDummy"
        AND COALESCE(
          CASE WHEN e."started_at_accuracy" IS NULL OR e."started_at_accuracy" = 'DAY' THEN e."started_at" END,
          e."first_signal_created_at") BETWEEN ${since} AND ${until}
        AND EXISTS (
          SELECT 1 FROM "signal_to_events" se
          JOIN "signals" o ON o."id" = se."signal_id"
          JOIN "data_sources" od ON od."id" = o."source_id"
          WHERE se."event_id" = e."id"
            AND od."name" <> ${source}
            AND ${ingestedSignal("o")}
        )
    )
    SELECT r."day",
      COUNT(*)::int AS "groundTruth",
      COUNT(*) FILTER (WHERE a."district" IS NOT NULL)::int AS "alerted"
    FROM reference r
    LEFT JOIN alerted a ON a."district" = r."district" AND a."day" = r."day"
    GROUP BY 1
  `;
}

/** The recall proxy over the requested range and location. */
export async function computeRecallMetrics(prisma: PrismaClient, input: RecallMetricsInput, now: Date = new Date()): Promise<RecallMetrics> {
  const range = resolveRange(input, now);
  const granularity = resolveGranularity(input.granularity);
  const rows = await fetchRecallRows(prisma, range, input.locationId || null);
  return summariseRecall(rows, range, granularity);
}
