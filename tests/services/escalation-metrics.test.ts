/**
 * Events escalated (ADR-0017), DB-free: the day rows folded into buckets,
 * and the range and location passed to the query.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { computeEscalationMetrics, summariseEscalations } from "../../src/services/escalation-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);
// ISO week 2026-W44: Monday 26 October to Sunday 1 November.
const range = { from: at("2026-10-26T00:00:00Z"), to: at("2026-11-01T23:59:59.999Z") };

describe("summariseEscalations", () => {
  const rows = [
    { day: day("2026-10-26"), events: 10, escalated: 1 },
    { day: day("2026-10-28"), events: 5, escalated: 2 },
    // Outside the buckets: in the totals only.
    { day: day("2026-11-03"), events: 4, escalated: 4 },
  ];

  it("folds the day rows into buckets, zero-filled, keeping rows outside them in the totals", () => {
    const m = summariseEscalations(rows, range, "WEEK");
    expect(m).toMatchObject({ granularity: "WEEK", events: 19, escalated: 7 });
    expect(m.series.map((b) => [b.label, b.events, b.escalated, b.isPartial])).toEqual([["2026-W44", 15, 3, false]]);
    const daily = summariseEscalations(rows, range, "DAY");
    expect(daily.series.map((b) => [b.label, b.events, b.escalated])).toEqual([
      ["2026-10-26", 10, 1],
      ["2026-10-27", 0, 0],
      ["2026-10-28", 5, 2],
      ["2026-10-29", 0, 0],
      ["2026-10-30", 0, 0],
      ["2026-10-31", 0, 0],
      ["2026-11-01", 0, 0],
    ]);
  });
});

describe("computeEscalationMetrics", () => {
  it("reads the Events in range for the location, counting escalations in the query", async () => {
    const $queryRaw = vi.fn(async () => []);
    const m = await computeEscalationMetrics({ $queryRaw } as unknown as PrismaClient, { ...range, locationId: "loc-sdn" }, at("2026-11-02T00:00:00Z"));
    expect(m.series).toEqual([{ start: at("2026-10-26T00:00:00Z"), label: "2026-W44", isPartial: false, events: 0, escalated: 0 }]);
    const [strings, ...values] = $queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain('"event_escaladed_by_users"');
    expect(strings.join("?")).toContain('e."first_signal_created_at"');
    expect(JSON.stringify(values)).toContain("loc-sdn");
  });
});
