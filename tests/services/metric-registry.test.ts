/**
 * The metric registry (ADR-0015), DB-free: the definitions it lists, and
 * `computeMetricSeries` reading each metric from the service that owns it,
 * so the generic series equals the metric's own query row for row.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import type { Granularity } from "../../src/services/detection-metrics.js";
import { computeDetectionMetrics } from "../../src/services/detection-metrics.js";
import { computeLocationPrecisionMetrics } from "../../src/services/location-precision-metrics.js";
import {
  METRIC_KEYS,
  computeMetricSeries,
  metricDefinition,
  metricDefinitions,
  type MetricKey,
} from "../../src/services/metric-registry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);

// Two measured Events (same day; next day) and one with no onset, in range on 7 Oct.
const EVENT_ROWS = [
  { startedAt: new Date("2026-10-05T00:00:00Z"), firstIngestedAt: new Date("2026-10-05T09:00:00Z") },
  { startedAt: new Date("2026-10-05T00:00:00Z"), firstIngestedAt: new Date("2026-10-06T09:00:00Z") },
  { startedAt: null, firstIngestedAt: new Date("2026-10-07T09:00:00Z") },
];
const SIGNAL_ROWS = [
  { source: "sudan-war-x", day: day("2026-10-05"), level: 2, count: 3 },
  { source: "sudan-war-x", day: day("2026-10-05"), level: 1, count: 4 },
  { source: "sudan-war-x", day: day("2026-10-07"), level: 4, count: 5 },
  { source: "dataminr", day: day("2026-10-06"), level: 4, count: 6 },
];

/** A Prisma stand-in answering the owning service's queries: Event rows, or Signal cells then correction cells. */
function prismaFor(kind: "events" | "signals") {
  const $queryRaw =
    kind === "events" ? vi.fn(async () => EVENT_ROWS) : vi.fn().mockResolvedValueOnce(SIGNAL_ROWS).mockResolvedValueOnce([]);
  return { prisma: { $queryRaw } as unknown as PrismaClient, $queryRaw };
}
const range = { from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z" };
const now = new Date("2026-10-14T09:00:00Z");

describe("metricDefinitions", () => {
  it("lists every key with its name, dimension, unit, text and grouping, without the reader", () => {
    const defs = metricDefinitions();
    expect(defs.map((d) => d.key)).toEqual([...METRIC_KEYS]);
    expect(defs.map((d) => [d.name, d.dimension, d.unit, d.groupable, d.adr])).toEqual([
      ["Detected by next day", "TIMELINESS", "EVENTS", false, "ADR-0011"],
      ["Detected same day", "TIMELINESS", "EVENTS", false, "ADR-0011"],
      ["At district or finer", "ACCURACY", "SIGNALS", true, "ADR-0012"],
    ]);
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(40);
      expect(d.timeBasis.length).toBeGreaterThan(10);
      expect(d).not.toHaveProperty("series");
    }
    expect(metricDefinition("DISTRICT_OR_FINER").groupable).toBe(true);
  });
});

describe("computeMetricSeries", () => {
  it("equals detectionMetrics' own series for the time-to-detection metrics", async () => {
    for (const [metric, field] of [
      ["DETECTED_BY_NEXT_DAY", "byNextDay"],
      ["DETECTED_SAME_DAY", "sameDay"],
    ] as const) {
      const own = await computeDetectionMetrics(prismaFor("events").prisma, { ...range, granularity: "DAY" }, now);
      const s = await computeMetricSeries(prismaFor("events").prisma, { metric, ...range, granularity: "DAY" }, now);
      expect(s).toMatchObject({ metric, granularity: "DAY", from: own.from, to: own.to, groups: [] });
      expect(s.buckets).toEqual(
        own.series.map((b) => ({ start: b.start, label: b.label, isPartial: b.isPartial, group: null, numerator: b[field], denominator: b.counted })),
      );
      expect(s.buckets).toHaveLength(7);
      expect(s.buckets[0]).toMatchObject({ label: "2026-10-05", numerator: 1, denominator: 1 });
      expect(s.buckets[1]).toMatchObject({ label: "2026-10-06", numerator: metric === "DETECTED_SAME_DAY" ? 0 : 1, denominator: 1 });
      expect(s.buckets[2]).toMatchObject({ label: "2026-10-07", numerator: 0, denominator: 0 });
    }
  });

  it("equals locationPrecisionMetrics' own series per source, and adds the sources up when ungrouped", async () => {
    const own = await computeLocationPrecisionMetrics(prismaFor("signals").prisma, { ...range, granularity: "WEEK" }, now);
    const grouped = await computeMetricSeries(
      prismaFor("signals").prisma,
      { metric: "DISTRICT_OR_FINER", ...range, granularity: "WEEK", groupBy: "SOURCE" },
      now,
    );
    expect(grouped).toMatchObject({ metric: "DISTRICT_OR_FINER", granularity: "WEEK", groups: ["sudan-war-x", "dataminr"] });
    expect(grouped.buckets).toEqual(
      own.series.map((row) => ({
        start: row.start,
        label: row.label,
        isPartial: row.isPartial,
        group: row.source,
        numerator: row.district + row.point,
        denominator: row.total,
      })),
    );
    expect(grouped.buckets.map((b) => [b.group, b.numerator, b.denominator])).toEqual([
      ["sudan-war-x", 8, 12],
      ["dataminr", 6, 6],
    ]);

    const ungrouped = await computeMetricSeries(prismaFor("signals").prisma, { metric: "DISTRICT_OR_FINER", ...range, granularity: "WEEK" }, now);
    expect(ungrouped.groups).toEqual([]);
    expect(ungrouped.buckets).toEqual([
      { start: new Date("2026-10-05T00:00:00Z"), label: "2026-W41", isPartial: false, group: null, numerator: 14, denominator: 18 },
    ]);
  });

  it("zero-fills an ungrouped series when no source has a row in range", async () => {
    const empty = () => ({ $queryRaw: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]) }) as unknown as PrismaClient;
    const ungrouped = await computeMetricSeries(empty(), { metric: "DISTRICT_OR_FINER", ...range, granularity: "DAY" }, now);
    expect(ungrouped.groups).toEqual([]);
    expect(ungrouped.buckets.map((b) => [b.label, b.group, b.numerator, b.denominator, b.isPartial])).toEqual([
      ["2026-10-05", null, 0, 0, false],
      ["2026-10-06", null, 0, 0, false],
      ["2026-10-07", null, 0, 0, false],
      ["2026-10-08", null, 0, 0, false],
      ["2026-10-09", null, 0, 0, false],
      ["2026-10-10", null, 0, 0, false],
      ["2026-10-11", null, 0, 0, false],
    ]);
    // Grouped, there is no group to fill: an empty run is the honest answer.
    const grouped = await computeMetricSeries(empty(), { metric: "DISTRICT_OR_FINER", ...range, granularity: "DAY", groupBy: "SOURCE" }, now);
    expect(grouped.groups).toEqual([]);
    expect(grouped.buckets).toEqual([]);
  });

  it("passes the location and the sources through to the owning query", async () => {
    const { prisma, $queryRaw } = prismaFor("signals");
    await computeMetricSeries(prisma, { metric: "DISTRICT_OR_FINER", ...range, locationId: "loc-sdn", sourceNames: ["sudan-war-x"], groupBy: "SOURCE" }, now);
    expect($queryRaw).toHaveBeenCalledTimes(2);
    for (const call of $queryRaw.mock.calls as unknown as Array<[unknown, ...unknown[]]>) {
      const [, ...values] = call;
      expect(JSON.stringify(values)).toContain("loc-sdn");
      expect(JSON.stringify(values)).toContain("sudan-war-x");
    }
  });

  it("refuses an unknown metric, a grouping the metric lacks, and an unknown granularity before querying", async () => {
    const { prisma, $queryRaw } = prismaFor("events");
    await expect(computeMetricSeries(prisma, { metric: "NOPE" as MetricKey }, now)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    await expect(computeMetricSeries(prisma, { metric: "DETECTED_SAME_DAY", groupBy: "SOURCE" }, now)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    await expect(
      computeMetricSeries(prisma, { metric: "DISTRICT_OR_FINER", granularity: "HOUR" as Granularity }, now),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
