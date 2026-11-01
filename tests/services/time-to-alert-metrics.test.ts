/**
 * Time to alert (ADR-0017), DB-free: the classification of an Alert against
 * its Event's onset, the series by the day the Alert was raised, and the
 * range and location passed to the query.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { classifyAlert, computeTimeToAlertMetrics, summariseAlerts, type AlertRow } from "../../src/services/time-to-alert-metrics.js";

const at = (iso: string) => new Date(iso);
// ISO week 2026-W44: Monday 26 October to Sunday 1 November.
const range = { from: at("2026-10-26T00:00:00Z"), to: at("2026-11-01T23:59:59.999Z") };

describe("classifyAlert", () => {
  it("counts whole UTC days from the onset to the Alert, or excludes under one reason", () => {
    expect(classifyAlert({ createdAt: at("2026-10-27T23:30:00Z"), startedAt: at("2026-10-27T00:00:00Z") })).toEqual({ counted: true, days: 0 });
    expect(classifyAlert({ createdAt: at("2026-10-28T00:10:00Z"), startedAt: at("2026-10-27T00:00:00Z") })).toEqual({ counted: true, days: 1 });
    expect(classifyAlert({ createdAt: at("2026-10-30T09:00:00Z"), startedAt: at("2026-10-27T00:00:00Z"), startedAtAccuracy: "DAY" })).toEqual({ counted: true, days: 3 });
    expect(classifyAlert({ createdAt: at("2026-10-30T09:00:00Z"), startedAt: null })).toEqual({ counted: false, reason: "NO_ONSET" });
    expect(classifyAlert({ createdAt: at("2026-10-30T09:00:00Z"), startedAt: at("2026-10-01T00:00:00Z"), startedAtAccuracy: "MONTH" })).toEqual({
      counted: false,
      reason: "COARSE_ONSET",
    });
    expect(classifyAlert({ createdAt: at("2026-10-26T09:00:00Z"), startedAt: at("2026-10-27T00:00:00Z") })).toEqual({ counted: false, reason: "BEFORE_ONSET" });
    // A backfilled creation instant beats every other reason: nothing about when it was raised is known.
    expect(classifyAlert({ createdAt: at("2026-05-14T07:30:07Z"), startedAt: at("2026-05-14T00:00:00Z"), backfilled: true })).toEqual({
      counted: false,
      reason: "BACKFILLED_TIMESTAMP",
    });
  });
});

describe("summariseAlerts", () => {
  const rows: AlertRow[] = [
    // Same day, Tuesday 27.
    { createdAt: at("2026-10-27T23:30:00Z"), startedAt: at("2026-10-27T00:00:00Z") },
    // Next day, three days, and no onset: all raised on Wednesday 28.
    { createdAt: at("2026-10-28T00:10:00Z"), startedAt: at("2026-10-27T00:00:00Z") },
    { createdAt: at("2026-10-28T12:00:00Z"), startedAt: at("2026-10-25T00:00:00Z") },
    { createdAt: at("2026-10-28T13:00:00Z"), startedAt: null },
    // A month-precise onset, Thursday 29; an Alert before its onset day, Monday 26.
    { createdAt: at("2026-10-29T13:00:00Z"), startedAt: at("2026-10-01T00:00:00Z"), startedAtAccuracy: "MONTH" },
    { createdAt: at("2026-10-26T09:00:00Z"), startedAt: at("2026-10-27T00:00:00Z") },
    // A backfilled creation instant, Friday 30: in range, never counted.
    { createdAt: at("2026-10-30T10:00:00Z"), startedAt: at("2026-10-30T00:00:00Z"), backfilled: true },
  ];

  it("buckets Alerts by the day they were raised, zero-filling the range", () => {
    const m = summariseAlerts(rows, range, "DAY");
    expect(m).toMatchObject({ alertsInRange: 7, counted: 3, sameDay: 1, byNextDay: 2, granularity: "DAY" });
    expect(m.exclusions).toEqual([
      { reason: "BACKFILLED_TIMESTAMP", count: 1 },
      { reason: "NO_ONSET", count: 1 },
      { reason: "COARSE_ONSET", count: 1 },
      { reason: "BEFORE_ONSET", count: 1 },
    ]);
    expect(m.series.map((b) => [b.label, b.alertsInRange, b.counted, b.sameDay, b.byNextDay])).toEqual([
      ["2026-10-26", 1, 0, 0, 0],
      ["2026-10-27", 1, 1, 1, 1],
      ["2026-10-28", 3, 2, 0, 1],
      ["2026-10-29", 1, 0, 0, 0],
      ["2026-10-30", 1, 0, 0, 0],
      ["2026-10-31", 0, 0, 0, 0],
      ["2026-11-01", 0, 0, 0, 0],
    ]);
    expect(m.series.every((b) => !b.isPartial)).toBe(true);
  });

  it("reads ISO weeks by default, and keeps an Alert outside the buckets in the totals only", () => {
    const m = summariseAlerts([...rows, { createdAt: at("2026-11-03T10:00:00Z"), startedAt: at("2026-11-03T00:00:00Z") }], range);
    expect(m.granularity).toBe("WEEK");
    expect(m.series.map((b) => [b.label, b.alertsInRange, b.counted, b.sameDay, b.byNextDay, b.isPartial])).toEqual([["2026-W44", 7, 3, 1, 2, false]]);
    expect(m).toMatchObject({ alertsInRange: 8, counted: 4, sameDay: 2, byNextDay: 3 });
  });
});

describe("computeTimeToAlertMetrics", () => {
  it("reads the Alerts raised in range, scoped to the location like time to detection", async () => {
    const $queryRaw = vi.fn(async () => []);
    const prisma = { $queryRaw } as unknown as PrismaClient;
    const m = await computeTimeToAlertMetrics(prisma, { ...range, locationId: "loc-sdn", granularity: "DAY" }, at("2026-11-02T00:00:00Z"));
    expect(m.series).toHaveLength(7);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = $queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain('FROM "alerts" a');
    expect(strings.join("?")).toContain('NOT e."isDummy"');
    expect(strings.join("?")).toContain('FROM "_prisma_migrations" m');
    expect(values).toContain("20260513000000_add_alert_and_location_timestamps");
    expect(JSON.stringify(values)).toContain("loc-sdn");
  });

  it("refuses an inverted range before querying", async () => {
    const $queryRaw = vi.fn();
    await expect(computeTimeToAlertMetrics({ $queryRaw } as unknown as PrismaClient, { from: range.to, to: range.from })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
