/**
 * Time to detection (ADR-0011), DB-free: the range defaults and limits, the
 * classification of one Event, ISO weeks, and the summary's shape (9
 * histogram rows, 4 exclusion rows, zero-filled weeks).
 */
import { describe, expect, it } from "vitest";
import { GraphQLError } from "graphql";
import {
  EXCLUSION_REASONS,
  classify,
  isoWeekLabel,
  resolveRange,
  startOfIsoWeek,
  summarise,
  type DetectionEventRow,
} from "../../src/services/detection-metrics.js";

const at = (iso: string) => new Date(iso);
const row = (startedAt: string | null, firstIngestedAt: string | null): DetectionEventRow => ({
  startedAt: startedAt ? at(startedAt) : null,
  firstIngestedAt: firstIngestedAt ? at(firstIngestedAt) : null,
});

function expectBadInput(fn: () => unknown, message: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions.code).toBe("BAD_USER_INPUT");
    expect((err as GraphQLError).message).toMatch(message);
    return;
  }
  throw new Error("expected BAD_USER_INPUT");
}

describe("ISO weeks", () => {
  it("starts a week on Monday 00:00 UTC", () => {
    expect(startOfIsoWeek(at("2026-10-14T15:30:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(startOfIsoWeek(at("2026-10-12T00:00:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(startOfIsoWeek(at("2026-10-18T23:59:59.999Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("labels a week by its ISO week-year", () => {
    expect(isoWeekLabel(at("2026-10-14T00:00:00Z"))).toBe("2026-W42");
    // 2027-01-01 is a Friday: it belongs to 2026's last week.
    expect(isoWeekLabel(at("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    // 2024-12-30 is a Monday in week 1 of 2025.
    expect(isoWeekLabel(at("2024-12-30T00:00:00Z"))).toBe("2025-W01");
    expect(isoWeekLabel(at("2026-01-05T00:00:00Z"))).toBe("2026-W02");
  });
});

describe("resolveRange", () => {
  const now = at("2026-10-14T09:00:00Z");

  it("defaults to now and the 12 ISO weeks ending in now's week", () => {
    const { from, to } = resolveRange({}, now);
    expect(to).toEqual(now);
    expect(from.toISOString()).toBe("2026-07-27T00:00:00.000Z");
    expect(isoWeekLabel(from)).toBe("2026-W31");
  });

  it("counts the 12 weeks back from a given `to`", () => {
    const { from } = resolveRange({ to: "2026-03-29T23:59:59.999Z" }, now);
    expect(from.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  it("refuses an inverted range, a span over 364 days, and an invalid date", () => {
    expectBadInput(() => resolveRange({ from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }, now), /before/);
    expectBadInput(() => resolveRange({ from: "2025-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }, now), /364 days/);
    expectBadInput(() => resolveRange({ from: "not a date" }, now), /valid date-time/);
  });

  it("accepts exactly 52 weeks, Monday to Sunday's last millisecond", () => {
    const r = resolveRange({ from: "2025-10-13T00:00:00Z", to: "2026-10-11T23:59:59.999Z" }, now);
    expect(r.from.toISOString()).toBe("2025-10-13T00:00:00.000Z");
  });
});

describe("classify", () => {
  it("counts whole UTC days from the onset day", () => {
    expect(classify(row("2026-10-01T00:00:00Z", "2026-10-01T22:15:00Z"))).toEqual({ counted: true, days: 0 });
    expect(classify(row("2026-10-01T00:00:00Z", "2026-10-02T00:05:00Z"))).toEqual({ counted: true, days: 1 });
    expect(classify(row("2026-10-01T00:00:00Z", "2026-10-15T08:00:00Z"))).toEqual({ counted: true, days: 14 });
    // An onset with a time still counts by its day.
    expect(classify(row("2026-10-01T23:00:00Z", "2026-10-01T23:30:00Z"))).toEqual({ counted: true, days: 0 });
  });

  it("excludes, by the first reason that applies", () => {
    expect(classify(row("2026-10-01T00:00:00Z", null))).toEqual({ counted: false, reason: "NO_INGESTED_SIGNAL" });
    expect(classify(row(null, null))).toEqual({ counted: false, reason: "NO_INGESTED_SIGNAL" });
    expect(classify(row(null, "2026-10-02T00:00:00Z"))).toEqual({ counted: false, reason: "NO_ONSET" });
    expect(classify(row("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"))).toEqual({
      counted: false,
      reason: "DATE_ONLY_FIRST_SIGNAL",
    });
    expect(classify(row("2026-10-03T00:00:00Z", "2026-09-30T00:00:00Z"))).toEqual({
      counted: false,
      reason: "DATE_ONLY_FIRST_SIGNAL",
    });
    expect(classify(row("2026-10-03T00:00:00Z", "2026-10-02T23:59:00Z"))).toEqual({ counted: false, reason: "BEFORE_ONSET" });
  });
});

describe("summarise", () => {
  const range = { from: at("2026-09-28T00:00:00Z"), to: at("2026-10-14T09:00:00Z") };

  it("counts, buckets and excludes every Event in range", () => {
    const m = summarise(
      [
        row("2026-09-29T00:00:00Z", "2026-09-29T10:00:00Z"), // W40, same day
        row("2026-09-29T00:00:00Z", "2026-09-30T10:00:00Z"), // W40, next day
        row("2026-10-01T00:00:00Z", "2026-10-06T10:00:00Z"), // W41, +5d
        row("2026-09-01T00:00:00Z", "2026-10-13T10:00:00Z"), // W42, 8d+
        row("2026-10-01T00:00:00Z", null), // history only
        row(null, "2026-10-02T10:00:00Z"), // no onset
        row("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"), // date only
        row("2026-10-05T00:00:00Z", "2026-10-04T10:00:00Z"), // before onset
      ],
      range,
    );
    expect(m).toMatchObject({ eventsInRange: 8, withOnset: 7, counted: 4, sameDay: 1, byNextDay: 2 });
    expect(m.histogram).toHaveLength(9);
    expect(m.histogram.map((b) => b.count)).toEqual([1, 1, 0, 0, 0, 1, 0, 0, 1]);
    expect(m.histogram.map((b) => b.isOpenEnded)).toEqual([false, false, false, false, false, false, false, false, true]);
    expect(m.histogram[8]!.daysAfterOnset).toBe(8);
    expect(m.exclusions).toEqual(EXCLUSION_REASONS.map((reason) => ({ reason, count: 1 })));
    expect(m.weekly).toEqual([
      { isoWeek: "2026-W40", weekStart: at("2026-09-28T00:00:00Z"), counted: 2, sameDay: 1, byNextDay: 2, isPartial: false },
      { isoWeek: "2026-W41", weekStart: at("2026-10-05T00:00:00Z"), counted: 1, sameDay: 0, byNextDay: 0, isPartial: false },
      { isoWeek: "2026-W42", weekStart: at("2026-10-12T00:00:00Z"), counted: 1, sameDay: 0, byNextDay: 0, isPartial: true },
    ]);
    expect(m.counted + m.exclusions.reduce((n, e) => n + e.count, 0)).toBe(m.eventsInRange);
  });

  it("zero-fills an empty range, marking a week the range starts inside as partial", () => {
    const m = summarise([], { from: at("2026-09-30T00:00:00Z"), to: at("2026-10-11T23:59:59.999Z") });
    expect(m).toMatchObject({ eventsInRange: 0, withOnset: 0, counted: 0, sameDay: 0, byNextDay: 0 });
    expect(m.histogram.every((b) => b.count === 0)).toBe(true);
    expect(m.exclusions.map((e) => e.count)).toEqual([0, 0, 0, 0]);
    expect(m.weekly.map((w) => [w.isoWeek, w.isPartial, w.counted])).toEqual([
      ["2026-W40", true, 0],
      ["2026-W41", false, 0],
    ]);
  });
});
