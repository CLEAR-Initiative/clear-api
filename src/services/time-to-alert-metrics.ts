/**
 * Time to alert (ADR-0017): how soon after an Event's real-world onset CLEAR
 * raised an Alert for it, in whole UTC days. One hop past time to detection
 * (ADR-0011), on the same discipline.
 *
 * An Alert in range is **counted** when its creation instant is real and its
 * Event has a day-precise onset on or before the Alert's creation day. Every
 * other Alert in range is **excluded** under exactly one reason, checked in
 * this order:
 *
 * 1. `BACKFILLED_TIMESTAMP` — the Alert predates its `createdAt` column:
 *    every Alert that existed when migration
 *    `20260513000000_add_alert_and_location_timestamps` ran was stamped with
 *    that run's instant (read from `_prisma_migrations`), so when it was
 *    raised is unknown.
 * 2. `NO_ONSET` — the Event has no onset to measure from.
 * 3. `COARSE_ONSET` — the onset is known to the week, month or year only.
 * 4. `BEFORE_ONSET` — the Alert predates the onset day, a data error.
 *
 * Days = UTC calendar days from the onset to the Alert's `createdAt`: same
 * day = 0, next day = 1. An Alert is in range when its `createdAt` is. Every
 * status counts: an Alert archived later was still raised when it was
 * created, and one the pipeline created already archived (a suppressed stale
 * Event) is a late Alert, not no Alert. There is one Alert per Event; dummy
 * Events take no part. The API returns counts only; clear-mvp turns them
 * into shares.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import {
  bucketIndex,
  bucketsOf,
  eventsInLocation,
  resolveGranularity,
  resolveRange,
  startOfBucket,
  utcDay,
  type Bucket,
  type DetectionMetricsInput,
  type Granularity,
} from "./detection-metrics.js";

export const ALERT_EXCLUSION_REASONS = ["BACKFILLED_TIMESTAMP", "NO_ONSET", "COARSE_ONSET", "BEFORE_ONSET"] as const;
export type AlertExclusionReason = (typeof ALERT_EXCLUSION_REASONS)[number];

/** The migration that added `alerts.created_at`; Alerts stamped with its run instant have no real creation instant. */
export const ALERT_TIMESTAMPS_MIGRATION = "20260513000000_add_alert_and_location_timestamps";

/** One Alert in range, as the metric needs it. */
export interface AlertRow {
  /** When the Alert was raised. */
  createdAt: Date;
  /** The Event's onset; null when none was resolved. */
  startedAt: Date | null;
  /** Precision of `startedAt`; null means day-precise (legacy rows). */
  startedAtAccuracy?: "DAY" | "WEEK" | "MONTH" | "YEAR" | null;
  /** True when `createdAt` is the timestamp migration's run instant rather than when the Alert was raised. */
  backfilled?: boolean | null;
}

export type AlertClassification =
  | { counted: true; days: number }
  | { counted: false; reason: AlertExclusionReason };

/** One bucket of the series: Alerts by the instant they were raised. */
export interface AlertBucketRow extends Bucket {
  /** Alerts raised in this bucket: counted plus excluded. */
  alertsInRange: number;
  counted: number;
  sameDay: number;
  byNextDay: number;
}

export interface TimeToAlertMetrics {
  from: Date;
  to: Date;
  alertsInRange: number;
  counted: number;
  sameDay: number;
  byNextDay: number;
  exclusions: Array<{ reason: AlertExclusionReason; count: number }>;
  granularity: Granularity;
  /** Zero-filled over every bucket the range touches, ascending. */
  series: AlertBucketRow[];
}

/** The same range, location and bucket size as time to detection. */
export type TimeToAlertInput = DetectionMetricsInput;

/** Counted with its whole days from onset, or excluded with its reason. */
export function classifyAlert(row: AlertRow): AlertClassification {
  if (row.backfilled) return { counted: false, reason: "BACKFILLED_TIMESTAMP" };
  if (!row.startedAt) return { counted: false, reason: "NO_ONSET" };
  if (row.startedAtAccuracy && row.startedAtAccuracy !== "DAY") return { counted: false, reason: "COARSE_ONSET" };
  const days = utcDay(row.createdAt) - utcDay(row.startedAt);
  if (days < 0) return { counted: false, reason: "BEFORE_ONSET" };
  return { counted: true, days };
}

/** The metric over the Alerts in range, read at `granularity` (ADR-0014). */
export function summariseAlerts(rows: AlertRow[], range: { from: Date; to: Date }, granularity: Granularity = "WEEK"): TimeToAlertMetrics {
  const exclusions = new Map<AlertExclusionReason, number>(ALERT_EXCLUSION_REASONS.map((r) => [r, 0]));
  const buckets = bucketsOf(range, granularity);
  const index = bucketIndex(buckets);
  const series: AlertBucketRow[] = buckets.map((bucket) => ({ ...bucket, alertsInRange: 0, counted: 0, sameDay: 0, byNextDay: 0 }));
  let counted = 0;
  let sameDay = 0;
  let byNextDay = 0;
  for (const row of rows) {
    const i = index.get(startOfBucket(row.createdAt, granularity).getTime());
    const cell = i === undefined ? null : series[i]!;
    if (cell) cell.alertsInRange++;
    const c = classifyAlert(row);
    if (!c.counted) {
      exclusions.set(c.reason, exclusions.get(c.reason)! + 1);
      continue;
    }
    counted++;
    if (c.days === 0) sameDay++;
    if (c.days <= 1) byNextDay++;
    if (cell) {
      cell.counted++;
      if (c.days === 0) cell.sameDay++;
      if (c.days <= 1) cell.byNextDay++;
    }
  }
  return {
    from: range.from,
    to: range.to,
    alertsInRange: rows.length,
    counted,
    sameDay,
    byNextDay,
    exclusions: ALERT_EXCLUSION_REASONS.map((reason) => ({ reason, count: exclusions.get(reason)! })),
    granularity,
    series,
  };
}

/**
 * The Alerts raised in range with their Event's onset, and whether their
 * `createdAt` is the timestamp migration's run instant (its `started_at` to
 * `finished_at` in `_prisma_migrations`, per environment, with a second's
 * margin because `created_at` keeps milliseconds and the migration log
 * microseconds). `locationId` keeps
 * the Alerts whose Event's origin, destination or general location is that
 * location or inside it, as time to detection does.
 */
export async function fetchAlertRows(prisma: PrismaClient, range: { from: Date; to: Date }, locationId: string | null): Promise<AlertRow[]> {
  return prisma.$queryRaw<AlertRow[]>`
    WITH stamp AS (
      SELECT MIN(m."started_at") AS "started_at", MAX(m."finished_at") AS "finished_at"
      FROM "_prisma_migrations" m
      WHERE m."migration_name" = ${ALERT_TIMESTAMPS_MIGRATION} AND m."rolled_back_at" IS NULL
    )
    SELECT a."created_at" AS "createdAt", e."started_at" AS "startedAt", e."started_at_accuracy" AS "startedAtAccuracy",
      COALESCE((a."created_at" AT TIME ZONE 'UTC')
        BETWEEN stamp."started_at" - interval '1 second' AND stamp."finished_at" + interval '1 second', false) AS "backfilled"
    FROM "alerts" a
    JOIN "events" e ON e."id" = a."event_id"
    CROSS JOIN stamp
    WHERE NOT e."isDummy"
      AND a."created_at" >= ${range.from}
      AND a."created_at" <= ${range.to}
      ${eventsInLocation(locationId)}
  `;
}

/** Time to alert over the requested range and location. */
export async function computeTimeToAlertMetrics(prisma: PrismaClient, input: TimeToAlertInput, now: Date = new Date()): Promise<TimeToAlertMetrics> {
  const range = resolveRange(input, now);
  const granularity = resolveGranularity(input.granularity);
  const rows = await fetchAlertRows(prisma, range, input.locationId || null);
  return summariseAlerts(rows, range, granularity);
}
