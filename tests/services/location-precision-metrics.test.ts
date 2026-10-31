/**
 * Location precision (ADR-0012), DB-free: the level buckets, the pure
 * summary (per source, per ISO week, zero-filled, ordered), the correction
 * buckets, and the range and filter handling in front of the queries.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  computeLocationPrecisionMetrics,
  correctionBucket,
  levelBucket,
  normaliseSourceNames,
  summarise,
} from "../../src/services/location-precision-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);
const range = (from: string, to: string) => ({ from: new Date(from), to: new Date(to) });

describe("levelBucket", () => {
  it("maps a location level to its bucket, with anything finer than a district a point", () => {
    expect(levelBucket(null)).toBe("noLocation");
    expect(levelBucket(undefined)).toBe("noLocation");
    expect(levelBucket(0)).toBe("country");
    expect(levelBucket(1)).toBe("state");
    expect(levelBucket(2)).toBe("district");
    expect(levelBucket(3)).toBe("point");
    expect(levelBucket(4)).toBe("point");
  });
});

describe("correctionBucket", () => {
  it("reads the stored open status as open and ignores unknown statuses", () => {
    expect(correctionBucket("consideration")).toBe("open");
    expect(correctionBucket("accepted")).toBe("accepted");
    expect(correctionBucket("corrected")).toBe("corrected");
    expect(correctionBucket("declined")).toBe("declined");
    expect(correctionBucket("superseded")).toBe("superseded");
    expect(correctionBucket("open")).toBe("open");
    expect(correctionBucket("something-else")).toBeNull();
  });
});

describe("summarise", () => {
  // Two full ISO weeks: W44 (26 Oct) and W45 (2 Nov).
  const r = range("2026-10-26T00:00:00Z", "2026-11-08T23:59:59.999Z");
  const rows = [
    { source: "sudan-war-x", day: day("2026-10-27"), level: 2, count: 3 },
    { source: "sudan-war-x", day: day("2026-10-27"), level: 1, count: 4 },
    { source: "sudan-war-x", day: day("2026-10-30"), level: 0, count: 2 },
    { source: "sudan-war-x", day: day("2026-11-03"), level: 4, count: 5 },
    { source: "sudan-war-x", day: day("2026-11-03"), level: null, count: 1 },
    { source: "dataminr", day: day("2026-10-26"), level: 4, count: 6 },
    { source: "dataminr", day: day("2026-11-08"), level: 0, count: 1 },
    { source: "acled", day: day("2026-11-02"), level: 4, count: 7 },
  ];

  it("counts each source once per level, most Signals first", () => {
    const m = summarise(rows, [], r);
    expect(m.signalsInRange).toBe(29);
    expect(m.bySource).toEqual([
      { source: "sudan-war-x", total: 15, noLocation: 1, country: 2, state: 4, district: 3, point: 5 },
      { source: "acled", total: 7, noLocation: 0, country: 0, state: 0, district: 0, point: 7 },
      { source: "dataminr", total: 7, noLocation: 0, country: 1, state: 0, district: 0, point: 6 },
    ]);
  });

  it("gives every source every week, zero-filled, in bySource order then ascending weeks", () => {
    const m = summarise(rows, [], r);
    expect(m.weekly.map((w) => `${w.source} ${w.isoWeek}`)).toEqual([
      "sudan-war-x 2026-W44",
      "sudan-war-x 2026-W45",
      "acled 2026-W44",
      "acled 2026-W45",
      "dataminr 2026-W44",
      "dataminr 2026-W45",
    ]);
    expect(m.weekly[0]).toMatchObject({
      weekStart: new Date("2026-10-26T00:00:00Z"),
      total: 9,
      noLocation: 0,
      country: 2,
      state: 4,
      district: 3,
      point: 0,
      isPartial: false,
    });
    expect(m.weekly[1]).toMatchObject({ total: 6, noLocation: 1, point: 5, isPartial: false });
    expect(m.weekly[2]).toMatchObject({ source: "acled", total: 0 });
    expect(m.weekly[3]).toMatchObject({ source: "acled", total: 7, point: 7 });
    expect(m.weekly[5]).toMatchObject({ source: "dataminr", isoWeek: "2026-W45", total: 1, country: 1 });
  });

  it("marks a week the range only partly covers as partial", () => {
    const m = summarise(rows.slice(0, 1), [], range("2026-10-28T00:00:00Z", "2026-11-04T12:00:00Z"));
    expect(m.weekly.map((w) => [w.isoWeek, w.isPartial])).toEqual([
      ["2026-W44", true],
      ["2026-W45", true],
    ]);
  });

  it("ignores empty cells and counts corrections by bucket, dropping unknown statuses", () => {
    const m = summarise(
      [{ source: "x", day: day("2026-10-27"), level: 2, count: 0 }],
      [
        { status: "consideration", count: 2 },
        { status: "accepted", count: 1 },
        { status: "declined", count: 3 },
        { status: "weird", count: 9 },
      ],
      r,
    );
    expect(m.signalsInRange).toBe(0);
    expect(m.bySource).toEqual([]);
    expect(m.weekly).toEqual([]);
    expect(m.corrections).toEqual({ open: 2, accepted: 1, corrected: 0, declined: 3, superseded: 0 });
  });
});

describe("normaliseSourceNames", () => {
  it("trims, drops blanks and duplicates, and tolerates null", () => {
    expect(normaliseSourceNames([" sudan-war-x ", "", "dataminr", "sudan-war-x"])).toEqual(["sudan-war-x", "dataminr"]);
    expect(normaliseSourceNames(null)).toEqual([]);
    expect(normaliseSourceNames(undefined)).toEqual([]);
  });
});

describe("computeLocationPrecisionMetrics", () => {
  function prisma(rows: unknown[] = [], corrections: unknown[] = []) {
    const $queryRaw = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce(corrections);
    return { client: { $queryRaw } as unknown as PrismaClient, $queryRaw };
  }

  it("defaults to the 12 ISO weeks ending now and asks for Signals then corrections", async () => {
    const { client, $queryRaw } = prisma();
    const m = await computeLocationPrecisionMetrics(client, {}, new Date("2026-10-31T10:00:00Z"));
    expect(m.from.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(m.to.toISOString()).toBe("2026-10-31T10:00:00.000Z");
    expect(m.bySource).toEqual([]);
    expect(m.weekly).toEqual([]);
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it("passes the location and the normalised source names into both queries", async () => {
    const { client, $queryRaw } = prisma();
    await computeLocationPrecisionMetrics(
      client,
      { from: "2026-10-26T00:00:00Z", to: "2026-11-01T23:59:59.999Z", locationId: "loc-sdn", sourceNames: [" sudan-war-x ", "sudan-war-x"] },
      new Date("2026-11-02T00:00:00Z"),
    );
    for (const call of $queryRaw.mock.calls as unknown as Array<[unknown, ...unknown[]]>) {
      const [, ...values] = call;
      const json = JSON.stringify(values);
      expect(json).toContain("loc-sdn");
      expect(json).toContain("sudan-war-x");
      expect(json.split("sudan-war-x").length - 1).toBe(1);
    }
  });

  it("refuses an inverted range or one over 364 days before querying", async () => {
    const { client, $queryRaw } = prisma();
    await expect(
      computeLocationPrecisionMetrics(client, { from: "2026-11-02T00:00:00Z", to: "2026-11-01T00:00:00Z" }),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      computeLocationPrecisionMetrics(client, { from: "2025-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" }),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

describe("summarise series (ADR-0014)", () => {
  const r = range("2026-10-26T00:00:00Z", "2026-11-08T23:59:59.999Z");
  const rows = [
    { source: "sudan-war-x", day: day("2026-10-27"), level: 2, count: 3 },
    { source: "sudan-war-x", day: day("2026-10-27"), level: 1, count: 4 },
    { source: "sudan-war-x", day: day("2026-11-03"), level: 4, count: 5 },
    { source: "dataminr", day: day("2026-10-26"), level: 4, count: 6 },
  ];

  it("equals weekly row for row at WEEK, the default", () => {
    const m = summarise(rows, [], r);
    expect(m.granularity).toBe("WEEK");
    expect(m.series).toEqual(m.weekly.map(({ isoWeek, weekStart, ...rest }) => ({ start: weekStart, label: isoWeek, ...rest })));
  });

  it("gives every source every day, zero-filled, in bySource order then ascending", () => {
    const m = summarise(rows, [], r, "DAY");
    expect(m.granularity).toBe("DAY");
    expect(m.series).toHaveLength(14 * 2);
    expect(m.series.slice(0, 14).every((b) => b.source === "sudan-war-x")).toBe(true);
    expect(m.series[1]).toMatchObject({
      label: "2026-10-27",
      start: new Date("2026-10-27T00:00:00Z"),
      source: "sudan-war-x",
      total: 7,
      state: 4,
      district: 3,
      isPartial: false,
    });
    expect(m.series[8]).toMatchObject({ label: "2026-11-03", source: "sudan-war-x", total: 5, point: 5 });
    expect(m.series[14]).toMatchObject({ label: "2026-10-26", source: "dataminr", total: 6, point: 6 });
    expect(m.series[15]).toMatchObject({ label: "2026-10-27", source: "dataminr", total: 0 });
    // The weekly rows are unaffected by the granularity.
    expect(m.weekly.map((w) => `${w.source} ${w.isoWeek}`)).toEqual([
      "sudan-war-x 2026-W44",
      "sudan-war-x 2026-W45",
      "dataminr 2026-W44",
      "dataminr 2026-W45",
    ]);
  });

  it("buckets by calendar month, marking a month the range only partly covers", () => {
    const m = summarise(rows, [], r, "MONTH");
    expect(m.series.map((b) => [b.source, b.label, b.total, b.isPartial])).toEqual([
      ["sudan-war-x", "2026-10", 7, true],
      ["sudan-war-x", "2026-11", 5, true],
      ["dataminr", "2026-10", 6, true],
      ["dataminr", "2026-11", 0, true],
    ]);
  });
});
