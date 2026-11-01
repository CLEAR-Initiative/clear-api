/**
 * Detection recall proxy (ADR-0018): of the events a reference dataset
 * recorded, how many did CLEAR raise an Alert for from its other feeds?
 *
 * ACLED stands in for ground truth: each of its Signals is one ACLED event,
 * dated by `publishedAt` and placed at a point under a district. An ACLED
 * event counts as **alerted nearby** when its district held a CLEAR Alert
 * whose Event's onset (or, without one, first Signal) lies within
 * `RECALL_WINDOW_DAYS` either side of the ACLED date, and that Event holds
 * at least one ingested Signal from a source other than ACLED, so that only
 * what CLEAR found on its own counts. An ACLED event with no district cannot
 * be matched and counts as not alerted. Retracted and dummy Signals take no
 * part. The location filter keeps the ACLED events in the location. The API
 * returns counts only.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  bucketIndex,
  bucketsOf,
  ingestedSignal,
  resolveGranularity,
  resolveRange,
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
  const inLocation = locationId
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM "locations" l
        WHERE l."id" = COALESCE(s."location_id", s."origin_id", s."destination_id")
          AND (l."id" = ${locationId} OR ${locationId} = ANY(l."ancestor_ids"))
      )`
    : Prisma.empty;
  return prisma.$queryRaw<RecallDayRow[]>`
    WITH reference AS (
      SELECT s."id", s."published_at",
        (SELECT l2."id" FROM "locations" l2
          WHERE l2."level" = 2 AND (l2."id" = l."id" OR l2."id" = ANY(l."ancestor_ids"))
          LIMIT 1) AS "district"
      FROM "signals" s
      JOIN "data_sources" ds ON ds."id" = s."source_id" AND ds."name" = ${source}
      LEFT JOIN "locations" l ON l."id" = COALESCE(s."location_id", s."origin_id", s."destination_id")
      WHERE NOT s."retracted"
        AND NOT s."isDummy"
        AND s."published_at" >= ${range.from}
        AND s."published_at" <= ${range.to}
        ${inLocation}
    )
    SELECT FLOOR(EXTRACT(EPOCH FROM r."published_at") / 86400)::int AS "day",
      COUNT(*)::int AS "groundTruth",
      COUNT(*) FILTER (WHERE r."district" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "alerts" al
        JOIN "events" e ON e."id" = al."event_id"
        JOIN "locations" el ON el."id" = COALESCE(e."location_id", e."origin_id", e."destination_id")
        WHERE NOT e."isDummy"
          AND (el."id" = r."district" OR r."district" = ANY(el."ancestor_ids"))
          AND COALESCE(e."started_at", e."first_signal_created_at")
            BETWEEN r."published_at" - make_interval(days => ${windowDays}) AND r."published_at" + make_interval(days => ${windowDays})
          AND EXISTS (
            SELECT 1 FROM "signal_to_events" se
            JOIN "signals" o ON o."id" = se."signal_id"
            JOIN "data_sources" od ON od."id" = o."source_id"
            WHERE se."event_id" = e."id"
              AND od."name" <> ${source}
              AND ${ingestedSignal("o")}
          )
      ))::int AS "alerted"
    FROM reference r
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
