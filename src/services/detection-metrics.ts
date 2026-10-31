/**
 * Time to detection (ADR-0011): how soon after an Event's real-world onset
 * CLEAR received its first Signal for it, in whole days.
 *
 * An Event in range is **counted** only when it has an onset (`startedAt`),
 * its first ingested Signal carries a real time of day, and that Signal is on
 * or after the onset day. Every other Event in range is **excluded** under
 * exactly one reason, checked in this order:
 *
 * 1. `NO_INGESTED_SIGNAL` — no live Signal a pipeline ingested: only history
 *    (accepted web cases carry `submittedById`) or Signals a person filed by
 *    hand (`createManualSignal` marks `rawData.manual`). Neither is CLEAR
 *    detecting the Event.
 * 2. `NO_ONSET` — no onset date to measure from.
 * 3. `DATE_ONLY_FIRST_SIGNAL` — the first ingested Signal's `publishedAt` is
 *    exactly UTC midnight: the source gave a date but no time.
 * 4. `BEFORE_ONSET` — the first ingested Signal is dated before the onset
 *    day, which is a data error.
 *
 * Onset is stored to the day, so TTD is the difference in UTC calendar days
 * between the first ingested Signal and the onset: same day = 0, next day = 1.
 *
 * An Event is in range when its first ingested Signal falls in the range, or,
 * with none, its `firstSignalCreatedAt` does. Dummy Events, and retracted or
 * dummy Signals, take no part. The API returns counts only; clear-mvp turns
 * them into shares.
 *
 * `weekly` is always ISO weeks; `series` is the same tally at the caller's
 * granularity (UTC day, ISO week or calendar month, ADR-0014). The bucket
 * helpers below are shared by every metric service.
 */

import { GraphQLError } from "graphql";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

export const EXCLUSION_REASONS = [
  "NO_INGESTED_SIGNAL",
  "NO_ONSET",
  "COARSE_ONSET",
  "DATE_ONLY_FIRST_SIGNAL",
  "BEFORE_ONSET",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** Histogram rows 0..7 days, then one open-ended row for 8 days and more. */
export const OPEN_ENDED_DAYS = 8;
/** The default range: this ISO week and the 11 before it. */
export const DEFAULT_WEEKS = 12;
/** The longest range a caller may ask for. */
export const MAX_SPAN_DAYS = 364;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The bucket sizes a metric series can be read in (ADR-0014). */
export const GRANULARITIES = ["DAY", "WEEK", "MONTH"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** One bucket of a series: when it starts, how it is labelled, and whether the range covers only part of it. */
export interface Bucket {
  /** 00:00 UTC of the day, the week's Monday, or the first of the month. */
  start: Date;
  /** `2026-10-29` for a day, `2026-W44` for an ISO week, `2026-10` for a month. */
  label: string;
  /** True when the range covers only part of the bucket, e.g. the current one. */
  isPartial: boolean;
}

/** One Event in range, as the metric needs it. */
export interface DetectionEventRow {
  /** Onset; null when none was resolved. */
  startedAt: Date | null;
  /** Precision of `startedAt`. A coarse onset (WEEK/MONTH/YEAR) can't give a
   *  meaningful whole-day delay, so it's excluded. Null = legacy/day-precise. */
  startedAtAccuracy?: "DAY" | "WEEK" | "MONTH" | "YEAR" | null;
  /** `publishedAt` of its earliest live ingested Signal; null when it has none. */
  firstIngestedAt: Date | null;
  /**
   * The instant that put it in range: `firstIngestedAt`, or, with none, its
   * `firstSignalCreatedAt`. Buckets `weekly[].eventsInRange`; when absent,
   * `firstIngestedAt` is used and an Event with neither joins no week.
   */
  inRangeAt?: Date | null;
}

export type Classification =
  | { counted: true; days: number }
  | { counted: false; reason: ExclusionReason };

/** One bucket of the detection series: counted Events by the instant of their first ingested Signal. */
export interface DetectionBucketRow extends Bucket {
  /** Events in range whose in-range instant falls in this bucket: counted plus excluded. */
  eventsInRange: number;
  counted: number;
  sameDay: number;
  byNextDay: number;
}

export interface DetectionMetrics {
  from: Date;
  to: Date;
  eventsInRange: number;
  withOnset: number;
  counted: number;
  sameDay: number;
  byNextDay: number;
  histogram: Array<{ daysAfterOnset: number; isOpenEnded: boolean; count: number }>;
  weekly: Array<{
    isoWeek: string;
    weekStart: Date;
    /** Events in range whose in-range instant falls in this week: counted plus excluded. */
    eventsInRange: number;
    counted: number;
    sameDay: number;
    byNextDay: number;
    isPartial: boolean;
  }>;
  exclusions: Array<{ reason: ExclusionReason; count: number }>;
  /** The bucket size `series` was read in. */
  granularity: Granularity;
  /** The same tally as `weekly` at `granularity` (ADR-0014), zero-filled, ascending; equal to `weekly` for WEEK. */
  series: DetectionBucketRow[];
}

export interface DetectionMetricsInput {
  from?: Date | string | null;
  to?: Date | string | null;
  locationId?: string | null;
  /** Bucket size of `series`; defaults to WEEK. */
  granularity?: Granularity | null;
}

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

/** Whole UTC days since the epoch: the calendar day an instant falls on. */
export function utcDay(at: Date): number {
  return Math.floor(at.getTime() / DAY_MS);
}

/** Monday 00:00 UTC of the ISO week `at` falls in. */
export function startOfIsoWeek(at: Date): Date {
  const day = utcDay(at);
  // 1970-01-01 was a Thursday: day 0 is weekday 3 counting from Monday.
  // Normalised so days before 1970 (negative) get a weekday in 0..6 too.
  const weekday = (((day + 3) % 7) + 7) % 7;
  return new Date((day - weekday) * DAY_MS);
}

/** The ISO week label, e.g. `2026-W42`; the year is the ISO week-year. */
export function isoWeekLabel(at: Date): string {
  const monday = startOfIsoWeek(at);
  // The week belongs to the year its Thursday falls in.
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = startOfIsoWeek(new Date(Date.UTC(year, 0, 4))).getTime() + 3 * DAY_MS;
  const week = Math.round((thursday.getTime() - firstThursday) / WEEK_MS) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** 00:00 UTC of the calendar day `at` falls on. */
export function startOfUtcDay(at: Date): Date {
  return new Date(utcDay(at) * DAY_MS);
}

/** 00:00 UTC on the first of the calendar month `at` falls in. */
export function startOfUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** The start of the bucket `at` falls in: its UTC day, ISO week or calendar month (ADR-0014). */
export function startOfBucket(at: Date, granularity: Granularity): Date {
  switch (granularity) {
    case "DAY":
      return startOfUtcDay(at);
    case "WEEK":
      return startOfIsoWeek(at);
    case "MONTH":
      return startOfUtcMonth(at);
  }
}

/** The start of the bucket after the one that starts at `start`. */
export function nextBucketStart(start: Date, granularity: Granularity): Date {
  switch (granularity) {
    case "DAY":
      return new Date(start.getTime() + DAY_MS);
    case "WEEK":
      return new Date(start.getTime() + WEEK_MS);
    case "MONTH":
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }
}

/** A bucket's label: `2026-10-29` for a day, `2026-W44` for an ISO week, `2026-10` for a month. */
export function bucketLabel(start: Date, granularity: Granularity): string {
  switch (granularity) {
    case "DAY":
      return start.toISOString().slice(0, 10);
    case "WEEK":
      return isoWeekLabel(start);
    case "MONTH":
      return start.toISOString().slice(0, 7);
  }
}

/**
 * Every bucket the range touches, ascending, for the caller to zero-fill. A
 * bucket is partial when the range covers only part of it; `to` is inclusive,
 * so a range ending at a bucket's last millisecond covers that bucket.
 */
export function bucketsOf(range: { from: Date; to: Date }, granularity: Granularity): Bucket[] {
  const buckets: Bucket[] = [];
  const last = startOfBucket(range.to, granularity).getTime();
  for (let start = startOfBucket(range.from, granularity); start.getTime() <= last; start = nextBucketStart(start, granularity)) {
    const end = nextBucketStart(start, granularity).getTime();
    buckets.push({
      start,
      label: bucketLabel(start, granularity),
      isPartial: start.getTime() < range.from.getTime() || end > range.to.getTime() + 1,
    });
  }
  return buckets;
}

/** Bucket index by start instant, for constant-time lookups while summarising. */
export function bucketIndex(buckets: Bucket[]): Map<number, number> {
  return new Map(buckets.map((bucket, i) => [bucket.start.getTime(), i]));
}

/** The caller's granularity, WEEK when none was given. */
export function resolveGranularity(value: Granularity | string | null | undefined): Granularity {
  if (value == null) return "WEEK";
  if (!(GRANULARITIES as readonly string[]).includes(value)) {
    throw badInput(`\`granularity\` must be one of ${GRANULARITIES.join(", ")}.`);
  }
  return value as Granularity;
}

function toDate(value: Date | string, name: string): Date {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) throw badInput(`\`${name}\` must be a valid date-time, e.g. 2026-10-14T00:00:00Z.`);
  return at;
}

/**
 * The range to measure. `to` defaults to now; `from` to the start of the
 * ISO week 11 weeks before `to`'s week, so the default is 12 ISO weeks.
 * Refuses an inverted range or one longer than 364 days.
 */
export function resolveRange(input: DetectionMetricsInput, now: Date): { from: Date; to: Date } {
  const to = input.to != null ? toDate(input.to, "to") : now;
  const from =
    input.from != null
      ? toDate(input.from, "from")
      : new Date(startOfIsoWeek(to).getTime() - (DEFAULT_WEEKS - 1) * WEEK_MS);
  if (from > to) throw badInput("`from` must be on or before `to`.");
  if (to.getTime() - from.getTime() > MAX_SPAN_DAYS * DAY_MS) {
    throw badInput(`The range can span at most ${MAX_SPAN_DAYS} days (52 weeks).`);
  }
  return { from, to };
}

/** Counted with its whole days from onset, or excluded with its reason. */
export function classify(row: DetectionEventRow): Classification {
  if (!row.firstIngestedAt) return { counted: false, reason: "NO_INGESTED_SIGNAL" };
  if (!row.startedAt) return { counted: false, reason: "NO_ONSET" };
  // A week/month/year-only onset would produce a spuriously precise day delay
  // (e.g. an October-only onset stored as Oct 1). Legacy rows (null accuracy)
  // stay day-precise, as before.
  if (row.startedAtAccuracy && row.startedAtAccuracy !== "DAY") {
    return { counted: false, reason: "COARSE_ONSET" };
  }
  if (row.firstIngestedAt.getTime() % DAY_MS === 0) return { counted: false, reason: "DATE_ONLY_FIRST_SIGNAL" };
  const days = utcDay(row.firstIngestedAt) - utcDay(row.startedAt);
  if (days < 0) return { counted: false, reason: "BEFORE_ONSET" };
  return { counted: true, days };
}

/** The metric over the Events in range, with `series` read at `granularity` (ADR-0014). */
export function summarise(
  rows: DetectionEventRow[],
  range: { from: Date; to: Date },
  granularity: Granularity = "WEEK",
): DetectionMetrics {
  const histogram = Array.from({ length: OPEN_ENDED_DAYS + 1 }, (_, d) => ({
    daysAfterOnset: d,
    isOpenEnded: d === OPEN_ENDED_DAYS,
    count: 0,
  }));
  const exclusions = new Map<ExclusionReason, number>(EXCLUSION_REASONS.map((r) => [r, 0]));

  // `weekly` is always ISO weeks, for the cards that predate `series`; `series`
  // is the same tally at the requested granularity (identical rows for WEEK).
  const weekBuckets = bucketsOf(range, "WEEK");
  const weekIndex = bucketIndex(weekBuckets);
  const weekly: DetectionMetrics["weekly"] = weekBuckets.map((bucket) => ({
    isoWeek: bucket.label,
    weekStart: bucket.start,
    eventsInRange: 0,
    counted: 0,
    sameDay: 0,
    byNextDay: 0,
    isPartial: bucket.isPartial,
  }));
  const seriesBuckets = bucketsOf(range, granularity);
  const seriesIndex = bucketIndex(seriesBuckets);
  const series: DetectionBucketRow[] = seriesBuckets.map((bucket) => ({
    ...bucket,
    eventsInRange: 0,
    counted: 0,
    sameDay: 0,
    byNextDay: 0,
  }));
  /** The weekly row and the series row an instant falls in; either can be missing at the range's edges. */
  const cellsAt = (at: Date) => {
    const cells: Array<{ eventsInRange: number; counted: number; sameDay: number; byNextDay: number }> = [];
    const w = weekIndex.get(startOfIsoWeek(at).getTime());
    if (w !== undefined) cells.push(weekly[w]!);
    const i = seriesIndex.get(startOfBucket(at, granularity).getTime());
    if (i !== undefined) cells.push(series[i]!);
    return cells;
  };

  let withOnset = 0;
  let counted = 0;
  let sameDay = 0;
  let byNextDay = 0;
  for (const row of rows) {
    if (row.startedAt) withOnset++;
    const inRangeAt = row.firstIngestedAt ?? row.inRangeAt ?? null;
    if (inRangeAt) for (const cell of cellsAt(inRangeAt)) cell.eventsInRange++;
    const c = classify(row);
    if (!c.counted) {
      exclusions.set(c.reason, exclusions.get(c.reason)! + 1);
      continue;
    }
    counted++;
    if (c.days === 0) sameDay++;
    if (c.days <= 1) byNextDay++;
    histogram[Math.min(c.days, OPEN_ENDED_DAYS)]!.count++;
    for (const cell of cellsAt(row.firstIngestedAt!)) {
      cell.counted++;
      if (c.days === 0) cell.sameDay++;
      if (c.days <= 1) cell.byNextDay++;
    }
  }

  return {
    from: range.from,
    to: range.to,
    eventsInRange: rows.length,
    withOnset,
    counted,
    sameDay,
    byNextDay,
    histogram,
    weekly,
    exclusions: EXCLUSION_REASONS.map((reason) => ({ reason, count: exclusions.get(reason)! })),
    granularity,
    series,
  };
}

/**
 * The Events in range with their onset and first ingested Signal. One pass
 * over the Signal links: an Event's first ingested Signal is the earliest
 * `publishedAt` of its live (non-retracted, non-dummy) Signals that no person
 * submitted (an accepted web case) or filed by hand (a manual Signal, whose
 * `rawData.manual` is true). `locationId` keeps the Events whose origin, destination or
 * general location is that location or inside it, as `eventsByLocation` does.
 */
export async function fetchDetectionEvents(
  prisma: PrismaClient,
  range: { from: Date; to: Date },
  locationId: string | null,
): Promise<DetectionEventRow[]> {
  const inLocation = locationId
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM "locations" l
        WHERE l."id" IN (e."origin_id", e."destination_id", e."location_id")
          AND (l."id" = ${locationId} OR ${locationId} = ANY(l."ancestor_ids"))
      )`
    : Prisma.empty;
  return prisma.$queryRaw<DetectionEventRow[]>`
    WITH first_ingested AS (
      SELECT se."event_id", MIN(s."published_at") AS "at"
      FROM "signal_to_events" se
      JOIN "signals" s ON s."id" = se."signal_id"
      WHERE s."submitted_by_id" IS NULL
        AND s."raw_data"->>'manual' IS DISTINCT FROM 'true'
        AND NOT s."retracted"
        AND NOT s."isDummy"
      GROUP BY se."event_id"
    )
    SELECT e."started_at" AS "startedAt", e."started_at_accuracy" AS "startedAtAccuracy",
      fi."at" AS "firstIngestedAt",
      COALESCE(fi."at", e."first_signal_created_at") AS "inRangeAt"
    FROM "events" e
    LEFT JOIN first_ingested fi ON fi."event_id" = e."id"
    WHERE NOT e."isDummy"
      AND COALESCE(fi."at", e."first_signal_created_at") >= ${range.from}
      AND COALESCE(fi."at", e."first_signal_created_at") <= ${range.to}
      ${inLocation}
  `;
}

/** Time to detection over the requested range and location. */
export async function computeDetectionMetrics(
  prisma: PrismaClient,
  input: DetectionMetricsInput,
  now: Date = new Date(),
): Promise<DetectionMetrics> {
  const range = resolveRange(input, now);
  const granularity = resolveGranularity(input.granularity);
  const rows = await fetchDetectionEvents(prisma, range, input.locationId || null);
  return summarise(rows, range, granularity);
}
