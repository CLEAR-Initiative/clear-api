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

const { metricDefinitions: metricDefinitionsQuery, metricSeries } = metricsResolvers.Query;

describe("metricDefinitions and metricSeries", () => {
  it("are FORBIDDEN to every role but admin, and UNAUTHENTICATED signed out, without a query", async () => {
    for (const role of ["analyst", "viewer", "pending", "worker", "pipeline"]) {
      const { ctx, $queryRaw } = context({ id: "u", role });
      expect(() => metricDefinitionsQuery(null, {}, ctx)).toThrowError(expect.objectContaining({ extensions: { code: "FORBIDDEN" } }));
      await expect(metricSeries(null, { input: { metric: "DISTRICT_OR_FINER" } }, ctx)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      expect($queryRaw).not.toHaveBeenCalled();
    }
    const { ctx } = context(null);
    await expect(metricSeries(null, { input: { metric: "DISTRICT_OR_FINER" } }, ctx)).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("list the registry and read a grouped series for an admin", async () => {
    const { ctx, $queryRaw } = context({ id: "a", role: "admin" });
    expect(metricDefinitionsQuery(null, {}, ctx).map((d) => d.key)).toEqual([
      "DETECTED_BY_NEXT_DAY",
      "DETECTED_SAME_DAY",
      "ALERTED_BY_NEXT_DAY",
      "ALERTED_SAME_DAY",
      "DISTRICT_OR_FINER",
      "SIGNALS_GROUPED",
      "EVENTS_WITH_ONE_SIGNAL",
      "ACLED_EVENTS_ALERTED",
      "SOURCES_ON_SCHEDULE",
      "EVENTS_ESCALATED",
    ]);
    const s = await metricSeries(
      null,
      { input: { metric: "DISTRICT_OR_FINER", from: new Date("2026-10-26T00:00:00Z"), to: new Date("2026-11-01T23:59:59.999Z"), granularity: "DAY", groupBy: "SOURCE" } },
      ctx,
    );
    expect(s).toMatchObject({ metric: "DISTRICT_OR_FINER", granularity: "DAY", groups: [], buckets: [] });
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it("refuses a grouping the metric lacks with BAD_USER_INPUT before querying", async () => {
    const { ctx, $queryRaw } = context({ id: "a", role: "admin" });
    await expect(metricSeries(null, { input: { metric: "DETECTED_SAME_DAY", groupBy: "SOURCE" } }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

const { metricAnnotations } = metricsResolvers.Query;
const { createMetricAnnotation: createAnnotation, deleteMetricAnnotation: deleteAnnotation } = metricsResolvers.Mutation;

function annotationContext(user: { id: string; role: string } | null) {
  const row = {
    id: "ann-1",
    at: new Date("2026-10-29T18:33:00Z"),
    label: "Geocoding inside the model's area",
    description: null,
    link: null,
    metricKeys: ["DISTRICT_OR_FINER"],
    createdById: "a",
    createdAt: new Date("2026-10-31T17:00:00Z"),
  };
  const prisma = {
    metricAnnotations: {
      findMany: vi.fn(async () => [row]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
      delete: vi.fn(async () => row),
    },
    activityLogs: { create: vi.fn(async () => ({})) },
  };
  const ctx = { prisma: prisma as unknown as Context["prisma"], user: user as Context["user"], session: null, authMethod: user ? "session" : null } as Context;
  return { ctx, prisma };
}

describe("metricAnnotations, createMetricAnnotation and deleteMetricAnnotation", () => {
  it("are FORBIDDEN to every role but admin, and UNAUTHENTICATED signed out, without touching the database", async () => {
    for (const role of ["analyst", "viewer", "pending", "worker", "pipeline"]) {
      const { ctx, prisma } = annotationContext({ id: "u", role });
      await expect(metricAnnotations(null, {}, ctx)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      await expect(
        createAnnotation(null, { input: { at: "2026-10-29T18:33:00Z", label: "x", metricKeys: ["DISTRICT_OR_FINER"] } }, ctx),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      await expect(deleteAnnotation(null, { id: "ann-1" }, ctx)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      expect(prisma.metricAnnotations.findMany).not.toHaveBeenCalled();
      expect(prisma.metricAnnotations.create).not.toHaveBeenCalled();
      expect(prisma.metricAnnotations.delete).not.toHaveBeenCalled();
    }
    const { ctx } = annotationContext(null);
    await expect(metricAnnotations(null, {}, ctx)).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("list, create and delete for an admin, logging each write", async () => {
    const { ctx, prisma } = annotationContext({ id: "a", role: "admin" });
    expect(await metricAnnotations(null, { input: { metric: "DISTRICT_OR_FINER" } }, ctx)).toHaveLength(1);
    const created = await createAnnotation(
      null,
      { input: { at: "2026-10-31T13:13:00Z", label: "Prompt v3", metricKeys: ["DISTRICT_OR_FINER"], link: "https://example.org/pr/152" } },
      ctx,
    );
    expect(created).toMatchObject({ label: "Prompt v3", createdById: "a" });
    expect(prisma.activityLogs.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ userId: "a", action: "metric_annotation.create", resourceType: "metric_annotation", resourceId: "ann-1" }),
    });
    expect(await deleteAnnotation(null, { id: "ann-1" }, ctx)).toBe(true);
    expect(prisma.activityLogs.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ userId: "a", action: "metric_annotation.delete", resourceId: "ann-1" }),
    });
  });

  it("refuses an invalid annotation with BAD_USER_INPUT before writing or logging", async () => {
    const { ctx, prisma } = annotationContext({ id: "a", role: "admin" });
    await expect(createAnnotation(null, { input: { at: "2026-10-31T13:13:00Z", label: "x", metricKeys: ["NOPE"] } }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(prisma.metricAnnotations.create).not.toHaveBeenCalled();
    expect(prisma.activityLogs.create).not.toHaveBeenCalled();
  });
});
