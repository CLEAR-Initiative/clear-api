/**
 * Events escalated (ADR-0017): the share of Events a user escalated to the
 * team. An interim usefulness proxy: nothing records yet whether an Alert
 * was actionable (Exponential #1268), but an analyst escalating an Event
 * (`escalateEvent`, which also raises its Alert) is a decision that it
 * mattered.
 *
 * An Event is in range by its `firstSignalCreatedAt`, the instant CLEAR first
 * had it; dummy Events take no part. An Event counts as escalated when any
 * user escalated it at any time, whether or not the escalation's week-long
 * window is still open. The API returns counts only; clear-mvp turns them
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
  type Bucket,
  type DetectionMetricsInput,
  type Granularity,
} from "./detection-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One UTC day of Events in range: how many, and how many of them a user escalated. */
export interface EscalationDayRow {
  /** Whole UTC days since the epoch of the Events' `firstSignalCreatedAt`. */
  day: number;
  events: number;
  escalated: number;
}

export interface EscalationBucketRow extends Bucket {
  events: number;
  escalated: number;
}

export interface EscalationMetrics {
  from: Date;
  to: Date;
  granularity: Granularity;
  events: number;
  escalated: number;
  /** Zero-filled over every bucket the range touches, ascending. */
  series: EscalationBucketRow[];
}

/** The same range, location and bucket size as time to detection. */
export type EscalationMetricsInput = DetectionMetricsInput;

/** The day rows folded into buckets of `granularity` (ADR-0014). */
export function summariseEscalations(rows: EscalationDayRow[], range: { from: Date; to: Date }, granularity: Granularity = "WEEK"): EscalationMetrics {
  const buckets = bucketsOf(range, granularity);
  const index = bucketIndex(buckets);
  const series: EscalationBucketRow[] = buckets.map((bucket) => ({ ...bucket, events: 0, escalated: 0 }));
  let events = 0;
  let escalated = 0;
  for (const row of rows) {
    events += row.events;
    escalated += row.escalated;
    const i = index.get(startOfBucket(new Date(row.day * DAY_MS), granularity).getTime());
    if (i === undefined) continue;
    series[i]!.events += row.events;
    series[i]!.escalated += row.escalated;
  }
  return { from: range.from, to: range.to, granularity, events, escalated, series };
}

/** The Events in range by UTC day of their first Signal, with how many a user escalated. */
export async function fetchEscalationRows(prisma: PrismaClient, range: { from: Date; to: Date }, locationId: string | null): Promise<EscalationDayRow[]> {
  return prisma.$queryRaw<EscalationDayRow[]>`
    SELECT FLOOR(EXTRACT(EPOCH FROM e."first_signal_created_at") / 86400)::int AS "day",
      COUNT(*)::int AS "events",
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "event_escaladed_by_users" x WHERE x."event_id" = e."id"))::int AS "escalated"
    FROM "events" e
    WHERE NOT e."isDummy"
      AND e."first_signal_created_at" >= ${range.from}
      AND e."first_signal_created_at" <= ${range.to}
      ${eventsInLocation(locationId)}
    GROUP BY 1
  `;
}

/** Events escalated over the requested range and location. */
export async function computeEscalationMetrics(prisma: PrismaClient, input: EscalationMetricsInput, now: Date = new Date()): Promise<EscalationMetrics> {
  const range = resolveRange(input, now);
  const granularity = resolveGranularity(input.granularity);
  const rows = await fetchEscalationRows(prisma, range, input.locationId || null);
  return summariseEscalations(rows, range, granularity);
}
