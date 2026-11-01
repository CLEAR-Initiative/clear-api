/**
 * Source health (ADR-0017), DB-free: which sources are expected, how each
 * ended day is judged against the source's cadence, the lookback before the
 * range, and the series by day and by week.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  EXPECTED_CADENCE_DAYS,
  computeSourceHealthMetrics,
  expectedSources,
  fetchSourceDeliveryRows,
  summariseSourceHealth,
} from "../../src/services/source-health-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);
// ISO week 2026-W44: Monday 26 October to Sunday 1 November.
const range = { from: at("2026-10-26T00:00:00Z"), to: at("2026-11-01T23:59:59.999Z") };
// Friday morning: Monday to Thursday have ended.
const now = at("2026-10-30T09:00:00Z");

describe("expectedSources", () => {
  it("lists the expected feeds in order, or the asked-for subset of them, ignoring names outside the list", () => {
    expect(expectedSources(null).map((s) => s.source)).toEqual(Object.keys(EXPECTED_CADENCE_DAYS));
    expect(expectedSources(["acled", " dataminr ", "nope"])).toEqual([
      { source: "dataminr", cadenceDays: 1 },
      { source: "acled", cadenceDays: 7 },
    ]);
    expect(expectedSources(["nope"])).toEqual([]);
  });
});

describe("summariseSourceHealth", () => {
  const sources = [
    { source: "daily", cadenceDays: 1 },
    { source: "weekly", cadenceDays: 7 },
  ];
  const rows = [
    { source: "daily", day: day("2026-10-26") },
    { source: "daily", day: day("2026-10-27") },
    { source: "daily", day: day("2026-10-29") },
    // The Friday before the range: within a week of Monday 26 to Thursday 29.
    { source: "weekly", day: day("2026-10-23") },
  ];

  it("judges each ended day against the source's cadence, by day", () => {
    const m = summariseSourceHealth(rows, range, sources, "DAY", now);
    expect(m.bySource).toEqual([
      { source: "daily", cadenceDays: 1, onScheduleDays: 3, days: 4 },
      { source: "weekly", cadenceDays: 7, onScheduleDays: 4, days: 4 },
    ]);
    const daily = m.series.filter((r) => r.source === "daily");
    expect(daily.map((r) => [r.label, r.onScheduleDays, r.days])).toEqual([
      ["2026-10-26", 1, 1],
      ["2026-10-27", 1, 1],
      ["2026-10-28", 0, 1],
      ["2026-10-29", 1, 1],
      ["2026-10-30", 0, 0],
      ["2026-10-31", 0, 0],
      ["2026-11-01", 0, 0],
    ]);
    expect(m.series.filter((r) => r.source === "weekly").map((r) => r.onScheduleDays)).toEqual([1, 1, 1, 1, 0, 0, 0]);
  });

  it("adds the days up per week, in source order", () => {
    const m = summariseSourceHealth(rows, range, sources, "WEEK", now);
    expect(m.series.map((r) => [r.source, r.label, r.onScheduleDays, r.days, r.isPartial])).toEqual([
      ["daily", "2026-W44", 3, 4, false],
      ["weekly", "2026-W44", 4, 4, false],
    ]);
  });

  it("runs out of schedule once a cadence passes without a delivery, and judges every day once the range is over", () => {
    const later = at("2026-11-02T00:00:00Z");
    const m = summariseSourceHealth([{ source: "weekly", day: day("2026-10-23") }], range, [{ source: "weekly", cadenceDays: 7 }], "DAY", later);
    // Friday 23 plus six days: Thursday 29 is the last day within the cadence.
    expect(m.series.map((r) => r.onScheduleDays)).toEqual([1, 1, 1, 1, 0, 0, 0]);
    expect(m.series.map((r) => r.days)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(m.bySource).toEqual([{ source: "weekly", cadenceDays: 7, onScheduleDays: 4, days: 7 }]);
  });

  it("has nothing to say with no expected source", () => {
    expect(summariseSourceHealth([], range, [], "WEEK", now)).toMatchObject({ bySource: [], series: [] });
  });
});

describe("fetchSourceDeliveryRows and computeSourceHealthMetrics", () => {
  it("asks from the longest cadence before the range, for the expected names only, and skips the query with no source", async () => {
    const $queryRaw = vi.fn(async () => []);
    const prisma = { $queryRaw } as unknown as PrismaClient;
    await fetchSourceDeliveryRows(prisma, range, [
      { source: "acled", cadenceDays: 7 },
      { source: "dataminr", cadenceDays: 1 },
    ]);
    const [strings, ...values] = $queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain('s."collected_at"');
    const json = JSON.stringify(values);
    expect(json).toContain("acled");
    expect(json).toContain("dataminr");
    // Six days before Monday 26: a delivery on Tuesday 20 still covers the Monday.
    expect(json).toContain("2026-10-20T00:00:00.000Z");
    expect(await fetchSourceDeliveryRows(prisma, range, [])).toEqual([]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it("reads the asked-for feeds over the range, judging the days that have ended", async () => {
    const $queryRaw = vi.fn(async () => [{ source: "dataminr", day: day("2026-10-26") }]);
    const m = await computeSourceHealthMetrics({ $queryRaw } as unknown as PrismaClient, { ...range, sourceNames: ["dataminr"], granularity: "DAY" }, now);
    expect(m.bySource).toEqual([{ source: "dataminr", cadenceDays: 1, onScheduleDays: 1, days: 4 }]);
    expect(m.series).toHaveLength(7);
    expect(m.series[0]).toMatchObject({ source: "dataminr", label: "2026-10-26", onScheduleDays: 1, days: 1 });
  });
});
