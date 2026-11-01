/**
 * The metric registry (ADR-0015): one entry per metric the admin /metrics
 * page can plot over time, and one series contract for all of them.
 *
 * Each metric is a **share per bucket**: `numerator / denominator`, read by
 * day, ISO week or calendar month (ADR-0014), optionally grouped (today by
 * data source). The registry does not define any metric: each entry reads
 * its series from the service that owns the definition (time to detection,
 * ADR-0011; location precision, ADR-0012), so `metricSeries` can never
 * disagree with the metric's own query. The API returns counts only;
 * clear-mvp turns them into shares.
 *
 * Adding a metric means one entry here and one value in the `MetricKey`
 * GraphQL enum. The entry's text is what clear-mvp's selector and method
 * notes show, and what the Notion Metrics table quotes. Time to alert,
 * source health and events escalated (ADR-0017) joined the first three under
 * Exponential #1266; the grouping and recall proxies (ADR-0018) under #1267.
 */

import { GraphQLError } from "graphql";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  bucketsOf,
  computeDetectionMetrics,
  resolveGranularity,
  type Bucket,
  type DetectionMetricsInput,
  type Granularity,
} from "./detection-metrics.js";
import { computeEscalationMetrics } from "./escalation-metrics.js";
import { computeSignalsGrouped, computeSingleSignalEvents } from "./grouping-metrics.js";
import { computeLocationPrecisionMetrics } from "./location-precision-metrics.js";
import { computeRecallMetrics } from "./recall-metrics.js";
import { computeSourceHealthMetrics } from "./source-health-metrics.js";
import { computeTimeToAlertMetrics } from "./time-to-alert-metrics.js";

export const METRIC_KEYS = [
  "DETECTED_BY_NEXT_DAY",
  "DETECTED_SAME_DAY",
  "ALERTED_BY_NEXT_DAY",
  "ALERTED_SAME_DAY",
  "DISTRICT_OR_FINER",
  "SIGNALS_GROUPED",
  "EVENTS_WITH_ONE_SIGNAL",
  "ACLED_EVENTS_ALERTED",
  "SOURCES_ON_SCHEDULE",
  "EVENTS_ESCALATED",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/** The Notion Metrics table's dimensions. */
export const METRIC_DIMENSIONS = ["TIMELINESS", "ACCURACY", "COVERAGE", "RELIABILITY", "USEFULNESS"] as const;
export type MetricDimension = (typeof METRIC_DIMENSIONS)[number];

/** What a metric's denominator counts: Events, Signals, source-days (one per expected source per measured day), or ACLED events. */
export const METRIC_UNITS = ["EVENTS", "SIGNALS", "SOURCE_DAYS", "ACLED_EVENTS"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export const METRIC_GROUP_BYS = ["SOURCE"] as const;
export type MetricGroupBy = (typeof METRIC_GROUP_BYS)[number];

export interface MetricSeriesInput {
  metric: MetricKey;
  granularity?: Granularity | null;
  from?: Date | string | null;
  to?: Date | string | null;
  locationId?: string | null;
  sourceNames?: string[] | null;
  groupBy?: MetricGroupBy | null;
}

/** One bucket of one group: the metric is `numerator / denominator`. */
export interface MetricBucket {
  start: Date;
  label: string;
  isPartial: boolean;
  /** The group (a `dataSources.name` under `groupBy: SOURCE`), null for an ungrouped series. */
  group: string | null;
  numerator: number;
  denominator: number;
}

export interface MetricSeries {
  metric: MetricKey;
  granularity: Granularity;
  from: Date;
  to: Date;
  /** Group names in the owning query's order: most Signals first for Signal metrics, the expected-cadence list for Sources on schedule; empty when ungrouped. */
  groups: string[];
  /** Group by group, ascending buckets within each, zero-filled over every bucket the range touches. */
  buckets: MetricBucket[];
}

/** What clients learn about a metric: enough to list it, group it and explain it. */
export interface MetricDefinition {
  key: MetricKey;
  name: string;
  dimension: MetricDimension;
  unit: MetricUnit;
  /** The method, in one paragraph: what counts, over what. */
  description: string;
  /** The instant that puts a row in a bucket. */
  timeBasis: string;
  /** True when the series can be read per data source (`groupBy: SOURCE`). */
  groupable: boolean;
  /** True when `locationId` scopes the series; false for a metric that reads every country, which clients should label. */
  locationScoped: boolean;
  /** The ADR that owns the definition. */
  adr: string;
}

interface RegistryEntry extends MetricDefinition {
  /** Reads the series from the owning service. */
  series: (prisma: PrismaClient, input: MetricSeriesInput, now: Date) => Promise<MetricSeries>;
}

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

/**
 * An ungrouped share read from the service that owns it: the service's
 * series rows in bucket order, with `pick` naming the numerator and the
 * denominator. One mapping for every Event-based reader.
 */
function ungroupedShare<Row extends Bucket>(
  metric: MetricKey,
  compute: (prisma: PrismaClient, input: DetectionMetricsInput, now: Date) => Promise<{ granularity: Granularity; from: Date; to: Date; series: Row[] }>,
  pick: (row: Row) => { numerator: number; denominator: number },
): RegistryEntry["series"] {
  return async (prisma, input, now) => {
    const m = await compute(prisma, { from: input.from, to: input.to, locationId: input.locationId, granularity: input.granularity }, now);
    return {
      metric,
      granularity: m.granularity,
      from: m.from,
      to: m.to,
      groups: [],
      buckets: m.series.map((row) => ({ start: row.start, label: row.label, isPartial: row.isPartial, group: null, ...pick(row) })),
    };
  };
}

/**
 * The groups added up per bucket, ascending, for an ungrouped read of a
 * grouped metric. With no group in range the owning query has no rows to add,
 * so the zero-filled run of buckets the contract promises is built here.
 */
function addUp(buckets: MetricBucket[], range: { from: Date; to: Date }, granularity: Granularity): MetricBucket[] {
  if (buckets.length === 0) {
    return bucketsOf(range, granularity).map((bucket) => ({ ...bucket, group: null, numerator: 0, denominator: 0 }));
  }
  const totals = new Map<number, MetricBucket>();
  for (const row of buckets) {
    const key = row.start.getTime();
    const total = totals.get(key);
    if (total) {
      total.numerator += row.numerator;
      total.denominator += row.denominator;
    } else {
      totals.set(key, { ...row, group: null });
    }
  }
  return [...totals.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

const sourcesOnSchedule: RegistryEntry["series"] = async (prisma, input, now) => {
  const m = await computeSourceHealthMetrics(
    prisma,
    { from: input.from, to: input.to, sourceNames: input.sourceNames, granularity: input.granularity },
    now,
  );
  const base = { metric: "SOURCES_ON_SCHEDULE" as const, granularity: m.granularity, from: m.from, to: m.to };
  const perSource = m.series.map((row) => ({
    start: row.start,
    label: row.label,
    isPartial: row.isPartial,
    group: row.source,
    numerator: row.onScheduleDays,
    denominator: row.days,
  }));
  if (input.groupBy === "SOURCE") return { ...base, groups: m.bySource.map((row) => row.source), buckets: perSource };
  return { ...base, groups: [], buckets: addUp(perSource, { from: m.from, to: m.to }, m.granularity) };
};

function sourceShare(metric: "SIGNALS_GROUPED" | "EVENTS_WITH_ONE_SIGNAL"): RegistryEntry["series"] {
  const compute = metric === "SIGNALS_GROUPED" ? computeSignalsGrouped : computeSingleSignalEvents;
  return async (prisma, input, now) => {
    const m = await compute(
      prisma,
      { from: input.from, to: input.to, locationId: input.locationId, sourceNames: input.sourceNames, granularity: input.granularity },
      now,
    );
    const base = { metric, granularity: m.granularity, from: m.from, to: m.to };
    const perSource = m.series.map((row) => ({
      start: row.start,
      label: row.label,
      isPartial: row.isPartial,
      group: row.source,
      numerator: row.numerator,
      denominator: row.denominator,
    }));
    if (input.groupBy === "SOURCE") return { ...base, groups: m.bySource.map((row) => row.source), buckets: perSource };
    return { ...base, groups: [], buckets: addUp(perSource, { from: m.from, to: m.to }, m.granularity) };
  };
}

const districtOrFiner: RegistryEntry["series"] = async (prisma, input, now) => {
  const m = await computeLocationPrecisionMetrics(
    prisma,
    {
      from: input.from,
      to: input.to,
      locationId: input.locationId,
      sourceNames: input.sourceNames,
      granularity: input.granularity,
    },
    now,
  );
  const base = { metric: "DISTRICT_OR_FINER" as const, granularity: m.granularity, from: m.from, to: m.to };
  if (input.groupBy === "SOURCE") {
    return {
      ...base,
      groups: m.bySource.map((row) => row.source),
      buckets: m.series.map((row) => ({
        start: row.start,
        label: row.label,
        isPartial: row.isPartial,
        group: row.source,
        numerator: row.district + row.point,
        denominator: row.total,
      })),
    };
  }
  // Ungrouped: every source added up per bucket, in bucket order.
  const perSource = m.series.map((row) => ({
    start: row.start,
    label: row.label,
    isPartial: row.isPartial,
    group: row.source,
    numerator: row.district + row.point,
    denominator: row.total,
  }));
  return { ...base, groups: [], buckets: addUp(perSource, { from: m.from, to: m.to }, m.granularity) };
};

const REGISTRY: Record<MetricKey, RegistryEntry> = {
  DETECTED_BY_NEXT_DAY: {
    key: "DETECTED_BY_NEXT_DAY",
    name: "Detected by next day",
    dimension: "TIMELINESS",
    unit: "EVENTS",
    description:
      "Share of measured Events whose first ingested Signal arrived on the onset day or the day after. An Event is measured when it has a day-precise onset and a first ingested Signal with a time of day on or after the onset day; every other Event in range is excluded under one reason (ADR-0011).",
    timeBasis: "The Event's first ingested Signal: its publishedAt.",
    groupable: false,
    locationScoped: true,
    adr: "ADR-0011",
    series: ungroupedShare("DETECTED_BY_NEXT_DAY", computeDetectionMetrics, (b) => ({ numerator: b.byNextDay, denominator: b.counted })),
  },
  DETECTED_SAME_DAY: {
    key: "DETECTED_SAME_DAY",
    name: "Detected same day",
    dimension: "TIMELINESS",
    unit: "EVENTS",
    description:
      "Share of measured Events whose first ingested Signal arrived on the onset day. Measured as for 'Detected by next day' (ADR-0011).",
    timeBasis: "The Event's first ingested Signal: its publishedAt.",
    groupable: false,
    locationScoped: true,
    adr: "ADR-0011",
    series: ungroupedShare("DETECTED_SAME_DAY", computeDetectionMetrics, (b) => ({ numerator: b.sameDay, denominator: b.counted })),
  },
  ALERTED_BY_NEXT_DAY: {
    key: "ALERTED_BY_NEXT_DAY",
    name: "Alerted by next day",
    dimension: "TIMELINESS",
    unit: "EVENTS",
    description:
      "Share of measured Alerts raised on the Event's onset day or the day after: one hop past time to detection. An Alert is measured when its creation instant is real and its Event has a day-precise onset on or before the day the Alert was raised; every other Alert in range is excluded under one reason, including the Alerts whose createdAt was backfilled when the column was added in May 2026. Every status counts: an Alert archived later was still raised when it was created, and one the pipeline created already archived is a late Alert (ADR-0017).",
    timeBasis: "The instant the Alert was raised: its createdAt.",
    groupable: false,
    locationScoped: true,
    adr: "ADR-0017",
    series: ungroupedShare("ALERTED_BY_NEXT_DAY", computeTimeToAlertMetrics, (b) => ({ numerator: b.byNextDay, denominator: b.counted })),
  },
  ALERTED_SAME_DAY: {
    key: "ALERTED_SAME_DAY",
    name: "Alerted same day",
    dimension: "TIMELINESS",
    unit: "EVENTS",
    description: "Share of measured Alerts raised on the Event's onset day. Measured as for 'Alerted by next day' (ADR-0017).",
    timeBasis: "The instant the Alert was raised: its createdAt.",
    groupable: false,
    locationScoped: true,
    adr: "ADR-0017",
    series: ungroupedShare("ALERTED_SAME_DAY", computeTimeToAlertMetrics, (b) => ({ numerator: b.sameDay, denominator: b.counted })),
  },
  DISTRICT_OR_FINER: {
    key: "DISTRICT_OR_FINER",
    name: "At district or finer",
    dimension: "ACCURACY",
    unit: "SIGNALS",
    description:
      "Share of ingested Signals placed at a district (admin-2) or at a point inside one, out of every ingested Signal located in the bucket; the rest sit at state or country level or have no location. Grouping keys on district, so this is the share grouping can use. A Signal a person corrected counts at the location the pipeline gave it (ADR-0012).",
    timeBasis: "The instant the Signal was last located: processedAt, else collectedAt.",
    groupable: true,
    locationScoped: true,
    adr: "ADR-0012",
    series: districtOrFiner,
  },
  SIGNALS_GROUPED: {
    key: "SIGNALS_GROUPED",
    name: "Signals grouped",
    dimension: "ACCURACY",
    unit: "SIGNALS",
    description:
      "Share of ingested Signals whose Event holds at least one other ingested Signal, out of every ingested Signal that has been through grouping. A grouping proxy, not a judgement: high can mean good merging or over-merging, low under-merging or many isolated reports; read it beside the correctness sample when one exists (ADR-0018).",
    timeBasis: "The Signal's publishedAt.",
    groupable: true,
    locationScoped: true,
    adr: "ADR-0018",
    series: sourceShare("SIGNALS_GROUPED"),
  },
  EVENTS_WITH_ONE_SIGNAL: {
    key: "EVENTS_WITH_ONE_SIGNAL",
    name: "Events with one signal",
    dimension: "ACCURACY",
    unit: "EVENTS",
    description:
      "Share of Events holding exactly one ingested Signal, out of every Event with an ingested Signal in range, grouped by the source of the Event's first ingested Signal. A grouping proxy for duplicates that were never merged (ADR-0018).",
    timeBasis: "The Event's first ingested Signal: its publishedAt.",
    groupable: true,
    locationScoped: true,
    adr: "ADR-0018",
    series: sourceShare("EVENTS_WITH_ONE_SIGNAL"),
  },
  ACLED_EVENTS_ALERTED: {
    key: "ACLED_EVENTS_ALERTED",
    name: "ACLED events alerted nearby",
    dimension: "COVERAGE",
    unit: "ACLED_EVENTS",
    description:
      "Share of ACLED events (ACLED's Signals, one per event, by event date) whose district held a CLEAR Alert within three days either side, on an Event with at least one ingested Signal from a source other than ACLED. A recall proxy: ACLED stands in for ground truth and only what CLEAR found through its other feeds counts; an ACLED event with no district counts as not alerted (ADR-0018).",
    timeBasis: "The ACLED event date: the Signal's publishedAt.",
    groupable: false,
    locationScoped: true,
    adr: "ADR-0018",
    series: ungroupedShare("ACLED_EVENTS_ALERTED", computeRecallMetrics, (b) => ({ numerator: b.alerted, denominator: b.groundTruth })),
  },
  SOURCES_ON_SCHEDULE: {
    key: "SOURCES_ON_SCHEDULE",
    name: "Sources on schedule",
    dimension: "RELIABILITY",
    unit: "SOURCE_DAYS",
    description:
      "Share of source-days on which an expected data feed was within its cadence. On each UTC day a source is on schedule when it delivered an ingested Signal within the last N days, N being its cadence: daily for dataminr, sudan-war-x and darfur24 (a delivery that very day), weekly for ACLED, fortnightly for IDMC and Sudan Witness. Only days that have ended are judged, and only the listed feeds; the location filter does not apply, so the reading covers every country (ADR-0017).",
    timeBasis: "Each UTC day of the range; a delivery is the Signal's collectedAt.",
    groupable: true,
    locationScoped: false,
    adr: "ADR-0017",
    series: sourcesOnSchedule,
  },
  EVENTS_ESCALATED: {
    key: "EVENTS_ESCALATED",
    name: "Events escalated",
    dimension: "USEFULNESS",
    unit: "EVENTS",
    description:
      "Share of Events a user escalated to the team, out of every Event whose first Signal arrived in the bucket. An interim usefulness proxy until actionability is recorded: an analyst escalating an Event is a decision that it mattered (ADR-0017).",
    timeBasis: "The Event's firstSignalCreatedAt.",
    groupable: false,
    locationScoped: true,
    adr: "ADR-0017",
    series: ungroupedShare("EVENTS_ESCALATED", computeEscalationMetrics, (b) => ({ numerator: b.escalated, denominator: b.events })),
  },
};

/** Every metric the page can plot, in registry order, without the readers. */
export function metricDefinitions(): MetricDefinition[] {
  return METRIC_KEYS.map((key) => {
    const { series: _series, ...definition } = REGISTRY[key];
    return definition;
  });
}

/** The definition of one metric. */
export function metricDefinition(key: MetricKey): MetricDefinition {
  const { series: _series, ...definition } = REGISTRY[key];
  return definition;
}

/**
 * One metric's series over the requested range, read from the service that
 * owns the metric. Refuses a key the registry does not know and a `groupBy`
 * the metric does not support with `BAD_USER_INPUT`; the range and
 * granularity rules are the owning service's.
 */
export async function computeMetricSeries(
  prisma: PrismaClient,
  input: MetricSeriesInput,
  now: Date = new Date(),
): Promise<MetricSeries> {
  const entry = (REGISTRY as Partial<Record<string, RegistryEntry>>)[input.metric];
  if (!entry) throw badInput(`\`metric\` must be one of ${METRIC_KEYS.join(", ")}.`);
  if (input.groupBy && !(METRIC_GROUP_BYS as readonly string[]).includes(input.groupBy)) {
    throw badInput(`\`groupBy\` must be one of ${METRIC_GROUP_BYS.join(", ")}.`);
  }
  if (input.groupBy && !entry.groupable) {
    throw badInput(`\`${entry.key}\` has no groups; leave \`groupBy\` out.`);
  }
  // Validate the granularity up front, so a bad value fails the same way whichever service runs.
  resolveGranularity(input.granularity);
  return entry.series(prisma, input, now);
}
