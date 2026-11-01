/**
 * Schema contract for `metricDefinitions` and `metricSeries` (ADR-0015): the
 * documents clear-mvp's `metrics.definitions` and `metrics.series` send,
 * executed through a real ApolloServer, so the enums, the input shape, every
 * selected field and the error codes are pinned at the seam.
 *
 * DB-FREE: `context.prisma.$queryRaw` is a `vi.fn()` mock answering the
 * owning service's queries.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

const METRIC_DEFINITIONS = `
  query MetricDefinitions {
    metricDefinitions { key name dimension unit description timeBasis groupable adr }
  }
`;

const METRIC_SERIES = `
  query MetricSeries($input: MetricSeriesInput!) {
    metricSeries(input: $input) {
      metric
      granularity
      from
      to
      groups
      buckets { start label isPartial group numerator denominator }
    }
  }
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);
const SIGNAL_ROWS = [
  { source: "sudan-war-x", day: day("2026-10-27"), level: 2, count: 3 },
  { source: "sudan-war-x", day: day("2026-10-28"), level: 1, count: 1 },
  // Fewer than sudan-war-x, so the groups come back sudan-war-x first.
  { source: "dataminr", day: day("2026-10-26"), level: 4, count: 2 },
];
const EVENT_ROWS = [
  { startedAt: new Date("2026-10-26T00:00:00Z"), firstIngestedAt: new Date("2026-10-26T09:00:00Z") },
  { startedAt: new Date("2026-10-26T00:00:00Z"), firstIngestedAt: new Date("2026-10-28T09:00:00Z") },
];

async function run(user: { id: string; role: string } | null, query: string, variables: Record<string, unknown>, rows: unknown[][]) {
  const $queryRaw = vi.fn();
  for (const answer of rows) $queryRaw.mockResolvedValueOnce(answer);
  const prisma = { $queryRaw };
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { prisma, user, session: null, authMethod: user ? "session" : null, locale: "en" } as unknown as Context },
  );
  await server.stop();
  if (response.body.kind !== "single") throw new Error(`Expected a single result, got ${response.body.kind}`);
  return { result: response.body.singleResult, prisma };
}

const admin = { id: "a", role: "admin" };
const range = { from: "2026-10-26T00:00:00.000Z", to: "2026-11-01T23:59:59.999Z" };

describe("metricDefinitions schema contract", () => {
  it("lists the registry for an admin and refuses everyone else", async () => {
    const { result, prisma } = await run(admin, METRIC_DEFINITIONS, {}, []);
    expect(result.errors).toBeUndefined();
    const defs = result.data?.metricDefinitions as Array<Record<string, unknown>>;
    expect(defs.map((d) => d.key)).toEqual([
      "DETECTED_BY_NEXT_DAY",
      "DETECTED_SAME_DAY",
      "ALERTED_BY_NEXT_DAY",
      "ALERTED_SAME_DAY",
      "DISTRICT_OR_FINER",
      "SOURCES_ON_SCHEDULE",
      "EVENTS_ESCALATED",
    ]);
    expect(defs[4]).toMatchObject({ name: "At district or finer", dimension: "ACCURACY", unit: "SIGNALS", groupable: true, adr: "ADR-0012" });
    expect(defs[5]).toMatchObject({ name: "Sources on schedule", dimension: "RELIABILITY", unit: "SOURCE_DAYS", groupable: true, adr: "ADR-0017" });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect((await run({ id: "u", role: "analyst" }, METRIC_DEFINITIONS, {}, [])).result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect((await run(null, METRIC_DEFINITIONS, {}, [])).result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
  });
});

describe("metricSeries schema contract", () => {
  it("reads district or finer per source by day", async () => {
    const { result, prisma } = await run(
      admin,
      METRIC_SERIES,
      { input: { metric: "DISTRICT_OR_FINER", granularity: "DAY", ...range, groupBy: "SOURCE", sourceNames: ["sudan-war-x", "dataminr"] } },
      [SIGNAL_ROWS, []],
    );
    expect(result.errors).toBeUndefined();
    const s = result.data?.metricSeries as { metric: string; granularity: string; groups: string[]; buckets: Array<Record<string, unknown>> };
    expect(s).toMatchObject({ metric: "DISTRICT_OR_FINER", granularity: "DAY", from: range.from, to: range.to, groups: ["sudan-war-x", "dataminr"] });
    expect(s.buckets).toHaveLength(14);
    expect(s.buckets[1]).toEqual({ start: "2026-10-27T00:00:00.000Z", label: "2026-10-27", isPartial: false, group: "sudan-war-x", numerator: 3, denominator: 3 });
    expect(s.buckets[2]).toEqual({ start: "2026-10-28T00:00:00.000Z", label: "2026-10-28", isPartial: false, group: "sudan-war-x", numerator: 0, denominator: 1 });
    expect(s.buckets[7]).toMatchObject({ label: "2026-10-26", group: "dataminr", numerator: 2, denominator: 2 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("reads a time-to-detection share ungrouped, by week, with only the metric given", async () => {
    const { result } = await run(admin, METRIC_SERIES, { input: { metric: "DETECTED_BY_NEXT_DAY" } }, [EVENT_ROWS]);
    expect(result.errors).toBeUndefined();
    const s = result.data?.metricSeries as { granularity: string; groups: string[]; buckets: Array<Record<string, unknown>> };
    expect(s.granularity).toBe("WEEK");
    expect(s.groups).toEqual([]);
    expect(s.buckets).toHaveLength(12);
    expect(s.buckets.every((b) => b.group === null)).toBe(true);
  });

  it("reads sources on schedule per source by day over a week that has ended", async () => {
    // ISO week 2026-W42, long over, so every day is judged whatever the clock says.
    const week = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-18T23:59:59.999Z" };
    const { result, prisma } = await run(
      admin,
      METRIC_SERIES,
      { input: { metric: "SOURCES_ON_SCHEDULE", granularity: "DAY", ...week, groupBy: "SOURCE", sourceNames: ["dataminr"] } },
      [[{ source: "dataminr", day: day("2026-10-12") }, { source: "dataminr", day: day("2026-10-13") }, { source: "dataminr", day: day("2026-10-15") }]],
    );
    expect(result.errors).toBeUndefined();
    const s = result.data?.metricSeries as { groups: string[]; buckets: Array<Record<string, unknown>> };
    expect(s.groups).toEqual(["dataminr"]);
    expect(s.buckets.map((b) => [b.label, b.group, b.numerator, b.denominator])).toEqual([
      ["2026-10-12", "dataminr", 1, 1],
      ["2026-10-13", "dataminr", 1, 1],
      ["2026-10-14", "dataminr", 0, 1],
      ["2026-10-15", "dataminr", 1, 1],
      ["2026-10-16", "dataminr", 0, 1],
      ["2026-10-17", "dataminr", 0, 1],
      ["2026-10-18", "dataminr", 0, 1],
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown metric at validation, a grouping the metric lacks, and a non-admin", async () => {
    const unknown = await run(admin, METRIC_SERIES, { input: { metric: "SOMETHING_ELSE" } }, []);
    expect(unknown.result.errors?.[0]?.message).toMatch(/MetricKey/);
    expect(unknown.prisma.$queryRaw).not.toHaveBeenCalled();
    const grouped = await run(admin, METRIC_SERIES, { input: { metric: "DETECTED_SAME_DAY", groupBy: "SOURCE" } }, []);
    expect(grouped.result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(grouped.result.errors?.[0]?.message).toMatch(/groupBy/);
    expect(grouped.prisma.$queryRaw).not.toHaveBeenCalled();
    const forbidden = await run({ id: "u", role: "analyst" }, METRIC_SERIES, { input: { metric: "DISTRICT_OR_FINER" } }, []);
    expect(forbidden.result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect(forbidden.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
