/**
 * `detectionMetrics`, DB-free: admins only (the database is never asked for
 * anyone else), the input reaches the query, and a refused range never
 * reaches the database.
 */
import { describe, expect, it, vi } from "vitest";
import { metricsResolvers } from "../../src/resolvers/metrics.resolver.js";
import type { Context } from "../../src/context.js";

function context(user: { id: string; role: string } | null) {
  const $queryRaw = vi.fn(async () => []);
  const ctx = {
    prisma: { $queryRaw } as unknown as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
  return { ctx, $queryRaw };
}

const { detectionMetrics } = metricsResolvers.Query;

describe("detectionMetrics", () => {
  it("is FORBIDDEN to every role but admin, and UNAUTHENTICATED signed out, without a query", async () => {
    for (const role of ["analyst", "viewer", "pending", "worker", "pipeline"]) {
      const { ctx, $queryRaw } = context({ id: "u", role });
      await expect(detectionMetrics(null, {}, ctx)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      expect($queryRaw).not.toHaveBeenCalled();
    }
    const { ctx } = context(null);
    await expect(detectionMetrics(null, {}, ctx)).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("measures the given range and location for an admin", async () => {
    const { ctx, $queryRaw } = context({ id: "a", role: "admin" });
    const m = await detectionMetrics(
      null,
      {
        input: {
          from: new Date("2026-09-28T00:00:00Z"),
          to: new Date("2026-10-11T23:59:59.999Z"),
          locationId: "loc-sdn",
          granularity: "DAY",
        },
      },
      ctx,
    );
    expect(m.from.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(m.weekly.map((w) => w.isoWeek)).toEqual(["2026-W40", "2026-W41"]);
    expect(m.granularity).toBe("DAY");
    expect(m.series).toHaveLength(14);
    expect(m.series[0]!.label).toBe("2026-09-28");
    expect(m.exclusions).toHaveLength(5);
    const [, ...values] = $queryRaw.mock.calls[0] as unknown as [unknown, ...unknown[]];
    expect(JSON.stringify(values)).toContain("loc-sdn");
  });

  it("refuses a span over 364 days with BAD_USER_INPUT before querying", async () => {
    const { ctx, $queryRaw } = context({ id: "a", role: "admin" });
    await expect(
      detectionMetrics(null, { input: { from: "2025-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

const { locationPrecisionMetrics } = metricsResolvers.Query;

describe("locationPrecisionMetrics", () => {
  it("is FORBIDDEN to every role but admin, and UNAUTHENTICATED signed out, without a query", async () => {
    for (const role of ["analyst", "viewer", "pending", "worker", "pipeline"]) {
      const { ctx, $queryRaw } = context({ id: "u", role });
      await expect(locationPrecisionMetrics(null, {}, ctx)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      expect($queryRaw).not.toHaveBeenCalled();
    }
    const { ctx } = context(null);
    await expect(locationPrecisionMetrics(null, {}, ctx)).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("measures the given range, location and sources for an admin", async () => {
    const { ctx, $queryRaw } = context({ id: "a", role: "admin" });
    const m = await locationPrecisionMetrics(
      null,
      {
        input: {
          from: new Date("2026-10-26T00:00:00Z"),
          to: new Date("2026-11-08T23:59:59.999Z"),
          locationId: "loc-sdn",
          sourceNames: ["sudan-war-x"],
          granularity: "MONTH",
        },
      },
      ctx,
    );
    expect(m.from.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(m.bySource).toEqual([]);
    expect(m.weekly).toEqual([]);
    expect(m.granularity).toBe("MONTH");
    expect(m.series).toEqual([]);
    expect(m.corrections).toEqual({ open: 0, accepted: 0, corrected: 0, declined: 0, superseded: 0 });
    expect($queryRaw).toHaveBeenCalledTimes(2);
    for (const call of $queryRaw.mock.calls as unknown as Array<[unknown, ...unknown[]]>) {
      const [, ...values] = call;
      expect(JSON.stringify(values)).toContain("loc-sdn");
      expect(JSON.stringify(values)).toContain("sudan-war-x");
    }
  });

  it("refuses a span over 364 days with BAD_USER_INPUT before querying", async () => {
    const { ctx, $queryRaw } = context({ id: "a", role: "admin" });
    await expect(
      locationPrecisionMetrics(null, { input: { from: "2025-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

const { agentMetrics } = metricsResolvers.Query;

describe("agentMetrics", () => {
  it("is FORBIDDEN to every role but admin, and UNAUTHENTICATED signed out, without a query", async () => {
    for (const role of ["analyst", "viewer", "pending", "worker", "pipeline"]) {
      const { ctx, $queryRaw } = context({ id: "u", role });
      await expect(agentMetrics(null, {}, ctx)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      expect($queryRaw).not.toHaveBeenCalled();
    }
    const { ctx } = context(null);
    await expect(agentMetrics(null, {}, ctx)).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("measures the given range for an admin, with the budget in force", async () => {
    const { ctx, $queryRaw } = context({ id: "a", role: "admin" });
    const m = await agentMetrics(
      null,
      { input: { from: new Date("2026-09-28T00:00:00Z"), to: new Date("2026-10-11T23:59:59.999Z") } },
      ctx,
    );
    expect(m.from.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(m.weekly.map((w) => w.isoWeek)).toEqual(["2026-W40", "2026-W41"]);
    expect(m.turns).toBe(0);
    expect(m.budgetLimitUsd).toBeGreaterThan(0);
    // The turns and the unrecorded count, both over the range.
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it("refuses a span over 364 days with BAD_USER_INPUT before querying", async () => {
    const { ctx, $queryRaw } = context({ id: "a", role: "admin" });
    await expect(
      agentMetrics(null, { input: { from: "2025-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
