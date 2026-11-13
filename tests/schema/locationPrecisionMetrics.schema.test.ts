/**
 * Schema contract for `locationPrecisionMetrics` (ADR-0012): the document
 * clear-mvp's `metrics.locationPrecision` sends, executed through a real
 * ApolloServer, so the input shape, every selected field and the error codes
 * are pinned at the seam.
 *
 * DB-FREE: `context.prisma.$queryRaw` is a `vi.fn()` mock answering the
 * Signal cells first and the correction cells second.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

// As clear-mvp's metrics router will send it.
const LOCATION_PRECISION_METRICS = `
  query LocationPrecisionMetrics($input: LocationPrecisionMetricsInput) {
    locationPrecisionMetrics(input: $input) {
      from
      to
      signalsInRange
      bySource { source total noLocation country state district point }
      weekly { isoWeek weekStart source total noLocation country state district point isPartial }
      granularity
      series { start label source total noLocation country state district point isPartial }
      corrections { open accepted corrected declined superseded }
    }
  }
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);

const ROWS = [
  { source: "sudan-war-x", day: day("2026-10-27"), level: 2, count: 3 },
  { source: "sudan-war-x", day: day("2026-10-28"), level: 1, count: 1 },
  { source: "sudan-war-x", day: day("2026-10-28"), level: null, count: 2 },
  { source: "dataminr", day: day("2026-10-26"), level: 4, count: 5 },
];
const CORRECTIONS = [
  { status: "consideration", count: 2 },
  { status: "declined", count: 1 },
];

async function run(user: { id: string; role: string } | null, variables: Record<string, unknown>) {
  const prisma = { $queryRaw: vi.fn().mockResolvedValueOnce(ROWS).mockResolvedValueOnce(CORRECTIONS) };
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query: LOCATION_PRECISION_METRICS, variables },
    { contextValue: { prisma, user, session: null, authMethod: user ? "session" : null, locale: "en" } as unknown as Context },
  );
  await server.stop();
  if (response.body.kind !== "single") throw new Error(`Expected a single result, got ${response.body.kind}`);
  return { result: response.body.singleResult, prisma };
}

describe("locationPrecisionMetrics schema contract", () => {
  it("executes clear-mvp's document for an admin", async () => {
    const { result, prisma } = await run(
      { id: "a", role: "admin" },
      {
        input: {
          from: "2026-10-26T00:00:00.000Z",
          to: "2026-11-01T23:59:59.999Z",
          locationId: "loc-sdn",
          sourceNames: ["sudan-war-x", "dataminr"],
        },
      },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.locationPrecisionMetrics).toEqual({
      from: "2026-10-26T00:00:00.000Z",
      to: "2026-11-01T23:59:59.999Z",
      signalsInRange: 11,
      bySource: [
        { source: "sudan-war-x", total: 6, noLocation: 2, country: 0, state: 1, district: 3, point: 0 },
        { source: "dataminr", total: 5, noLocation: 0, country: 0, state: 0, district: 0, point: 5 },
      ],
      weekly: [
        {
          isoWeek: "2026-W44",
          weekStart: "2026-10-26T00:00:00.000Z",
          source: "sudan-war-x",
          total: 6,
          noLocation: 2,
          country: 0,
          state: 1,
          district: 3,
          point: 0,
          isPartial: false,
        },
        {
          isoWeek: "2026-W44",
          weekStart: "2026-10-26T00:00:00.000Z",
          source: "dataminr",
          total: 5,
          noLocation: 0,
          country: 0,
          state: 0,
          district: 0,
          point: 5,
          isPartial: false,
        },
      ],
      granularity: "WEEK",
      series: [
        {
          start: "2026-10-26T00:00:00.000Z",
          label: "2026-W44",
          source: "sudan-war-x",
          total: 6,
          noLocation: 2,
          country: 0,
          state: 1,
          district: 3,
          point: 0,
          isPartial: false,
        },
        {
          start: "2026-10-26T00:00:00.000Z",
          label: "2026-W44",
          source: "dataminr",
          total: 5,
          noLocation: 0,
          country: 0,
          state: 0,
          district: 0,
          point: 5,
          isPartial: false,
        },
      ],
      corrections: { open: 2, accepted: 0, corrected: 0, declined: 1, superseded: 0 },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("reads the series by day per source when asked", async () => {
    const { result } = await run(
      { id: "a", role: "admin" },
      { input: { from: "2026-10-26T00:00:00.000Z", to: "2026-11-01T23:59:59.999Z", granularity: "DAY" } },
    );
    expect(result.errors).toBeUndefined();
    const m = result.data?.locationPrecisionMetrics as { granularity: string; series: Array<Record<string, unknown>> };
    expect(m.granularity).toBe("DAY");
    expect(m.series).toHaveLength(14);
    expect(m.series.slice(0, 7).map((b) => b.source)).toEqual(Array<string>(7).fill("sudan-war-x"));
    expect(m.series[1]).toMatchObject({ label: "2026-10-27", source: "sudan-war-x", total: 3, district: 3, isPartial: false });
    expect(m.series[2]).toMatchObject({ label: "2026-10-28", source: "sudan-war-x", total: 3, state: 1, noLocation: 2 });
    expect(m.series[7]).toMatchObject({ label: "2026-10-26", source: "dataminr", total: 5, point: 5 });
    expect(m.series[13]).toMatchObject({ label: "2026-11-01", source: "dataminr", total: 0 });
  });

  it("accepts no input at all", async () => {
    const { result } = await run({ id: "a", role: "admin" }, {});
    expect(result.errors).toBeUndefined();
    const m = result.data?.locationPrecisionMetrics as { weekly: unknown[]; signalsInRange: number };
    expect(m.signalsInRange).toBe(11);
    expect(m.weekly.length).toBeGreaterThanOrEqual(12 * 2);
  });

  it("is FORBIDDEN to an analyst and refuses a bad range with BAD_USER_INPUT", async () => {
    const forbidden = await run({ id: "u", role: "analyst" }, {});
    expect(forbidden.result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect(forbidden.prisma.$queryRaw).not.toHaveBeenCalled();
    const bad = await run({ id: "a", role: "admin" }, { input: { from: "2026-11-02T00:00:00Z", to: "2026-11-01T00:00:00Z" } });
    expect(bad.result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(bad.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
