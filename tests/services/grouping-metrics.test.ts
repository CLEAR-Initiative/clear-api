/**
 * Grouping proxies (ADR-0018), DB-free: the day rows folded per source and
 * bucket, the source order, and the range, location and sources passed to
 * the two queries.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { computeSignalsGrouped, computeSingleSignalEvents, foldSourceDays } from "../../src/services/grouping-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);
// ISO week 2026-W44: Monday 26 October to Sunday 1 November.
const range = { from: at("2026-10-26T00:00:00Z"), to: at("2026-11-01T23:59:59.999Z") };

describe("foldSourceDays", () => {
  const rows = [
    { source: "sudan-war-x", day: day("2026-10-26"), numerator: 2, denominator: 10 },
    { source: "sudan-war-x", day: day("2026-10-28"), numerator: 5, denominator: 8 },
    { source: "dataminr", day: day("2026-10-27"), numerator: 20, denominator: 25 },
    // Outside the buckets: in the source's totals only.
    { source: "dataminr", day: day("2026-11-03"), numerator: 1, denominator: 1 },
  ];

  it("zero-fills every bucket per source, most rows first, by day and by week", () => {
    const daily = foldSourceDays(rows, range, "DAY");
    expect(daily.bySource).toEqual([
      { source: "dataminr", numerator: 21, denominator: 26 },
      { source: "sudan-war-x", numerator: 7, denominator: 18 },
    ]);
    expect(daily.series.map((r) => [r.source, r.label, r.numerator, r.denominator])).toEqual([
      ["dataminr", "2026-10-26", 0, 0],
      ["dataminr", "2026-10-27", 20, 25],
      ["dataminr", "2026-10-28", 0, 0],
      ["dataminr", "2026-10-29", 0, 0],
      ["dataminr", "2026-10-30", 0, 0],
      ["dataminr", "2026-10-31", 0, 0],
      ["dataminr", "2026-11-01", 0, 0],
      ["sudan-war-x", "2026-10-26", 2, 10],
      ["sudan-war-x", "2026-10-27", 0, 0],
      ["sudan-war-x", "2026-10-28", 5, 8],
      ["sudan-war-x", "2026-10-29", 0, 0],
      ["sudan-war-x", "2026-10-30", 0, 0],
      ["sudan-war-x", "2026-10-31", 0, 0],
      ["sudan-war-x", "2026-11-01", 0, 0],
    ]);
    const weekly = foldSourceDays(rows, range);
    expect(weekly.granularity).toBe("WEEK");
    expect(weekly.series.map((r) => [r.source, r.label, r.numerator, r.denominator, r.isPartial])).toEqual([
      ["dataminr", "2026-W44", 20, 25, false],
      ["sudan-war-x", "2026-W44", 7, 18, false],
    ]);
  });

  it("breaks a tie on the source name, and has no rows for no sources", () => {
    const tied = foldSourceDays(
      [
        { source: "b", day: day("2026-10-26"), numerator: 1, denominator: 5 },
        { source: "a", day: day("2026-10-26"), numerator: 1, denominator: 5 },
      ],
      range,
    );
    expect(tied.bySource.map((s) => s.source)).toEqual(["a", "b"]);
    expect(foldSourceDays([], range)).toMatchObject({ bySource: [], series: [] });
  });
});

describe("computeSignalsGrouped and computeSingleSignalEvents", () => {
  it("each run one query with the range, the location and the sources, and fold what comes back", async () => {
    for (const [compute, marker] of [
      [computeSignalsGrouped, '"signal_to_events" se2'],
      [computeSingleSignalEvents, "first_ingested"],
    ] as const) {
      const $queryRaw = vi.fn(async () => [{ source: "dataminr", day: day("2026-10-27"), numerator: 3, denominator: 4 }]);
      const m = await compute({ $queryRaw } as unknown as PrismaClient, { ...range, locationId: "loc-sdn", sourceNames: [" dataminr ", "dataminr"], granularity: "DAY" }, at("2026-11-02T00:00:00Z"));
      expect(m.bySource).toEqual([{ source: "dataminr", numerator: 3, denominator: 4 }]);
      expect(m.series).toHaveLength(7);
      expect($queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = $queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
      expect(strings.join("?")).toContain(marker);
      const json = JSON.stringify(values);
      expect(json).toContain("loc-sdn");
      // The source filter is normalised: trimmed, deduplicated.
      expect((json.match(/dataminr/g) ?? []).length).toBe(1);
    }
  });

  it("refuse an inverted range before querying", async () => {
    const $queryRaw = vi.fn();
    await expect(computeSignalsGrouped({ $queryRaw } as unknown as PrismaClient, { from: range.to, to: range.from })).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
