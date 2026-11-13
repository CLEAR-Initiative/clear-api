/**
 * Schema contract for `detectionMetrics` (ADR-0011): the exact document
 * clear-mvp's `metrics.detection` sends, executed through a real ApolloServer,
 * so the input shape, every selected field, the enum values and the error
 * codes are pinned at the seam.
 *
 * DB-FREE: `context.prisma.$queryRaw` is a `vi.fn()` mock returning Event rows.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

// As in clear-mvp src/server/api/routers/metrics.ts.
const DETECTION_METRICS = `
  query DetectionMetrics($input: DetectionMetricsInput) {
    detectionMetrics(input: $input) {
      from
      to
      eventsInRange
      withOnset
      counted
      sameDay
      byNextDay
      histogram { daysAfterOnset isOpenEnded count }
      weekly { isoWeek weekStart counted sameDay byNextDay isPartial }
      granularity
      series { start label eventsInRange counted sameDay byNextDay isPartial }
      exclusions { reason count }
    }
  }
`;

const ROWS = [
  { startedAt: new Date("2026-10-05T00:00:00Z"), firstIngestedAt: new Date("2026-10-05T09:00:00Z") },
  { startedAt: null, firstIngestedAt: new Date("2026-10-06T09:00:00Z") },
];

async function run(user: { id: string; role: string } | null, variables: Record<string, unknown>) {
  const prisma = { $queryRaw: vi.fn().mockResolvedValue(ROWS) };
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query: DETECTION_METRICS, variables },
    { contextValue: { prisma, user, session: null, authMethod: user ? "session" : null, locale: "en" } as unknown as Context },
  );
  await server.stop();
  if (response.body.kind !== "single") throw new Error(`Expected a single result, got ${response.body.kind}`);
  return { result: response.body.singleResult, prisma };
}

describe("detectionMetrics schema contract", () => {
  it("executes clear-mvp's document for an admin", async () => {
    const { result } = await run(
      { id: "a", role: "admin" },
      { input: { from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z", locationId: "loc-sdn" } },
    );
    expect(result.errors).toBeUndefined();
    const m = result.data?.detectionMetrics as Record<string, unknown>;
    expect(m).toMatchObject({
      from: "2026-10-05T00:00:00.000Z",
      to: "2026-10-11T23:59:59.999Z",
      eventsInRange: 2,
      withOnset: 1,
      counted: 1,
      sameDay: 1,
      byNextDay: 1,
      weekly: [{ isoWeek: "2026-W41", weekStart: "2026-10-05T00:00:00.000Z", counted: 1, sameDay: 1, byNextDay: 1, isPartial: false }],
      granularity: "WEEK",
      series: [
        { start: "2026-10-05T00:00:00.000Z", label: "2026-W41", eventsInRange: 2, counted: 1, sameDay: 1, byNextDay: 1, isPartial: false },
      ],
      exclusions: [
        { reason: "NO_INGESTED_SIGNAL", count: 0 },
        { reason: "NO_ONSET", count: 1 },
        { reason: "COARSE_ONSET", count: 0 },
        { reason: "DATE_ONLY_FIRST_SIGNAL", count: 0 },
        { reason: "BEFORE_ONSET", count: 0 },
      ],
    });
    expect(m.histogram).toHaveLength(9);
  });

  it("reads the series by day when asked, and refuses an unknown granularity", async () => {
    const { result } = await run(
      { id: "a", role: "admin" },
      { input: { from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z", granularity: "DAY" } },
    );
    expect(result.errors).toBeUndefined();
    const m = result.data?.detectionMetrics as { granularity: string; series: Array<Record<string, unknown>>; weekly: unknown[] };
    expect(m.granularity).toBe("DAY");
    expect(m.series.map((b) => b.label)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(m.series[0]).toMatchObject({ start: "2026-10-05T00:00:00.000Z", eventsInRange: 1, counted: 1, sameDay: 1, byNextDay: 1, isPartial: false });
    expect(m.series[1]).toMatchObject({ label: "2026-10-06", eventsInRange: 1, counted: 0 });
    expect(m.weekly).toHaveLength(1);
    const bad = await run({ id: "a", role: "admin" }, { input: { granularity: "HOUR" } });
    expect(bad.result.errors?.[0]?.message).toMatch(/MetricGranularity/);
  });

  it("takes no input at all, applying the default range", async () => {
    const { result } = await run({ id: "a", role: "admin" }, {});
    expect(result.errors).toBeUndefined();
    expect((result.data?.detectionMetrics as { weekly: unknown[] }).weekly).toHaveLength(12);
  });

  it("surfaces FORBIDDEN for a non-admin, UNAUTHENTICATED signed out, BAD_USER_INPUT for a long range", async () => {
    expect((await run({ id: "u", role: "analyst" }, {})).result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect((await run(null, {})).result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
    const long = await run({ id: "a", role: "admin" }, { input: { from: "2025-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" } });
    expect(long.result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(long.result.errors?.[0]?.message).toMatch(/364 days/);
  });
});
