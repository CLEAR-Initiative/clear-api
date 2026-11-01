/**
 * Detection recall proxy (ADR-0018), DB-free: the day rows folded into
 * buckets, and the reference source, window, range and location passed to
 * the query.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { GROUND_TRUTH_SOURCE, RECALL_WINDOW_DAYS, computeRecallMetrics, fetchRecallRows, summariseRecall } from "../../src/services/recall-metrics.js";
import { EXPECTED_CADENCE_DAYS } from "../../src/services/source-health-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);
// ISO week 2026-W44: Monday 26 October to Sunday 1 November.
const range = { from: at("2026-10-26T00:00:00Z"), to: at("2026-11-01T23:59:59.999Z") };

describe("GROUND_TRUTH_SOURCE", () => {
  it("is one of the expected feeds, so a rename happens in one place and source health flags it when silent", () => {
    expect(Object.keys(EXPECTED_CADENCE_DAYS)).toContain(GROUND_TRUTH_SOURCE);
  });
});

describe("summariseRecall", () => {
  it("folds the day rows into buckets, zero-filled, keeping rows outside them in the totals", () => {
    const rows = [
      { day: day("2026-10-26"), groundTruth: 20, alerted: 8 },
      { day: day("2026-10-30"), groundTruth: 5, alerted: 1 },
      { day: day("2026-11-03"), groundTruth: 4, alerted: 4 },
    ];
    const m = summariseRecall(rows, range);
    expect(m).toMatchObject({ granularity: "WEEK", groundTruth: 29, alerted: 13 });
    expect(m.series.map((b) => [b.label, b.groundTruth, b.alerted, b.isPartial])).toEqual([["2026-W44", 25, 9, false]]);
    expect(summariseRecall(rows, range, "DAY").series.map((b) => [b.label, b.groundTruth, b.alerted])).toEqual([
      ["2026-10-26", 20, 8],
      ["2026-10-27", 0, 0],
      ["2026-10-28", 0, 0],
      ["2026-10-29", 0, 0],
      ["2026-10-30", 5, 1],
      ["2026-10-31", 0, 0],
      ["2026-11-01", 0, 0],
    ]);
  });
});

describe("fetchRecallRows and computeRecallMetrics", () => {
  it("ask for the reference source's events in range and in the location, with the window in days", async () => {
    const $queryRaw = vi.fn(async () => []);
    const prisma = { $queryRaw } as unknown as PrismaClient;
    const m = await computeRecallMetrics(prisma, { ...range, locationId: "loc-sdn", granularity: "DAY" }, at("2026-11-02T00:00:00Z"));
    expect(m.series).toHaveLength(7);
    const [strings, ...values] = $queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    // The alerted Events are read from four days before the range to four days after it (the window plus a day's slack).
    expect(JSON.stringify(values)).toContain("2026-10-22T00:00:00.000Z");
    expect(JSON.stringify(values)).toContain("2026-11-05T23:59:59.999Z");
    expect(sql).toContain('l2."level" = 2');
    expect(sql).toContain('FROM "alerts" al');
    // One pass over the alerted Events, dated by a day-precise onset else the first Signal, through any place.
    expect(sql).toContain("alerted AS (");
    expect(sql).toContain("generate_series(?, ?)");
    expect(sql).toContain('LEFT JOIN alerted a ON a."district" = r."district" AND a."day" = r."day"');
    expect(values).toContain(-RECALL_WINDOW_DAYS);
    expect(sql).toContain(`e."started_at_accuracy" = 'DAY'`);
    expect(sql).toContain('(VALUES (e."location_id"), (e."origin_id"), (e."destination_id"))');
    expect(values).toContain(GROUND_TRUTH_SOURCE);
    expect(values).toContain(RECALL_WINDOW_DAYS);
    expect(JSON.stringify(values)).toContain("loc-sdn");
  });

  it("take another reference feed and window for a test to bring its own", async () => {
    const $queryRaw = vi.fn(async () => []);
    await fetchRecallRows({ $queryRaw } as unknown as PrismaClient, range, null, "my-feed", 1);
    const [, ...values] = $queryRaw.mock.calls[0] as unknown as [unknown, ...unknown[]];
    expect(values).toContain("my-feed");
    expect(values).toContain(1);
    expect(values).not.toContain(GROUND_TRUTH_SOURCE);
  });
});
