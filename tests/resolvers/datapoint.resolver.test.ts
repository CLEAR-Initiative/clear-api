/**
 * Unit tests for `datapoint.resolver.ts`.
 *
 * DB-FREE: every `context.prisma.*` delegate is a `vi.fn()` stub. No
 * real Prisma client, no database. Focus on the branches that carry
 * real logic:
 *
 *   Query.reportDatapoint         — auth gate + delegate call shape.
 *   Query.hasAggregatedDatapoints — auth gate + validTo:null filter.
 *   Query.aggregatedDatapoint     — cache-hit vs on-demand fallback,
 *                                   asOf validity-window filter,
 *                                   empty-scope null return.
 *   Mutation.upsertReportDatapoints    — role gate, empty-id BAD_USER_INPUT,
 *                                        create-vs-replace distinction.
 *   Mutation.refreshAggregatedDatapoints — role gate, empty-window no-op,
 *                                          hierarchy resolution driving
 *                                          the four-tier bucket enumeration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

import { datapointResolvers } from "../../src/resolvers/datapoint.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
    locale: "en",
  } as Context;
}

const {
  reportDatapoint, hasAggregatedDatapoints, aggregatedDatapoint,
} = datapointResolvers.Query;
const {
  upsertReportDatapoints, refreshAggregatedDatapoints,
} = datapointResolvers.Mutation;

const VIEWER = { id: "u1", role: "viewer" };
const ADMIN = { id: "u2", role: "admin" };
const PIPELINE = { id: "u3", role: "pipeline" };
const PENDING = { id: "u4", role: "pending" };

// ────────────────────────────────────────────────────────────────────
// Query.reportDatapoint
// ────────────────────────────────────────────────────────────────────

describe("Query.reportDatapoint", () => {
  it("rejects pending users via requireContentReader", async () => {
    const ctx = buildContext(PENDING, {
      reportDatapoint: { findUnique: vi.fn() },
    });
    await expect(
      reportDatapoint(null, { reportId: "r1" }, ctx),
    ).rejects.toThrow(GraphQLError);
  });

  it("returns the row for a valid content reader", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "row1", reportId: "r1" });
    const ctx = buildContext(VIEWER, { reportDatapoint: { findUnique } });
    const result = await reportDatapoint(null, { reportId: "r1" }, ctx);
    expect(result).toEqual({ id: "row1", reportId: "r1" });
    expect(findUnique).toHaveBeenCalledWith({ where: { reportId: "r1" } });
  });
});

// ────────────────────────────────────────────────────────────────────
// Query.hasAggregatedDatapoints
// ────────────────────────────────────────────────────────────────────

describe("Query.hasAggregatedDatapoints", () => {
  it("returns true only when a current row exists", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "agg1" });
    const ctx = buildContext(VIEWER, { aggregatedDatapoint: { findFirst } });
    const result = await hasAggregatedDatapoints(
      null, { schemaVersion: "v1" }, ctx,
    );
    expect(result).toBe(true);
    // Critical: filter must include validTo: null so superseded
    // history rows don't count.
    expect(findFirst).toHaveBeenCalledWith({
      where: { schemaVersion: "v1", validTo: null },
      select: { id: true },
    });
  });

  it("returns false when only superseded history rows exist", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, { aggregatedDatapoint: { findFirst } });
    const result = await hasAggregatedDatapoints(
      null, { schemaVersion: "v1" }, ctx,
    );
    expect(result).toBe(false);
  });

  it("rejects pending users", async () => {
    const ctx = buildContext(PENDING, {
      aggregatedDatapoint: { findFirst: vi.fn() },
    });
    await expect(
      hasAggregatedDatapoints(null, { schemaVersion: "v1" }, ctx),
    ).rejects.toThrow(GraphQLError);
  });
});

// ────────────────────────────────────────────────────────────────────
// Query.aggregatedDatapoint — cache path
// ────────────────────────────────────────────────────────────────────

describe("Query.aggregatedDatapoint", () => {
  const args = {
    locationId: "sd0201",
    windowStart: new Date("2026-07-06T00:00:00Z"),
    windowEnd: new Date("2026-07-12T23:59:59Z"),
    windowKind: "weekly",
  };

  it("returns the cached row with onDemand=false on a hit", async () => {
    const cachedRow = {
      id: "agg1",
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      windowKind: "weekly",
      locationId: "sd0201",
      data: { killed_total: { value: 5, quality_score: 0.8 } },
      contributingReportIds: ["r1"],
      newestSourceAt: new Date(),
      oldestSourceAt: new Date(),
      dataQualityScore: 0.8,
      reportCount: 1,
      validFrom: new Date(),
      validTo: null,
      schemaVersion: "v1",
      computedAt: new Date(),
    };
    const ctx = buildContext(VIEWER, {
      aggregatedDatapoint: { findFirst: vi.fn().mockResolvedValue(cachedRow) },
      reportDatapoint: { findMany: vi.fn() },
    });
    const result = await aggregatedDatapoint(null, args, ctx);
    expect(result).not.toBeNull();
    expect(result?.onDemand).toBe(false);
    expect(result?.id).toBe("agg1");
  });

  it("falls through to on-demand aggregation on a miss", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const findMany = vi.fn().mockResolvedValue([
      {
        reportId: "r-live",
        publishedAt: new Date("2026-07-10T00:00:00Z"),
        reportingPeriodStart: null,
        reportingPeriodEnd: new Date("2026-07-08T00:00:00Z"),
        locationIds: ["sd0201"],
        data: {
          casualties: {
            killed: {
              total: {
                value: 12, unit: "people", confidence: "reported",
                source_quote: "twelve killed", chunk_index: 0, page_number: 1,
              },
            },
          },
        },
      },
    ]);
    const ctx = buildContext(VIEWER, {
      aggregatedDatapoint: { findFirst },
      reportDatapoint: { findMany },
    });
    const result = await aggregatedDatapoint(null, args, ctx);
    expect(result).not.toBeNull();
    expect(result?.onDemand).toBe(true);
    // Synthesised id makes cache-hit vs on-demand visibly distinct
    // for downstream React-key purposes.
    expect(result?.id).toContain("ondemand:");
    expect(result?.reportCount).toBe(1);
  });

  it("returns null when no cache and no contributing reports", async () => {
    const ctx = buildContext(VIEWER, {
      aggregatedDatapoint: { findFirst: vi.fn().mockResolvedValue(null) },
      reportDatapoint: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const result = await aggregatedDatapoint(null, args, ctx);
    expect(result).toBeNull();
  });

  it("applies asOf when selecting a historical cache version", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, {
      aggregatedDatapoint: { findFirst },
      reportDatapoint: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const asOf = new Date("2026-06-01T00:00:00Z");
    await aggregatedDatapoint(null, { ...args, asOf }, ctx);
    // The findFirst call MUST filter on validFrom<=asOf and (validTo IS
    // NULL OR validTo > asOf) — else the "give me what was current a
    // week ago" contract breaks.
    const call = findFirst.mock.calls[0]![0];
    expect(call.where.validFrom.lte).toEqual(asOf);
    expect(call.where.OR).toEqual([
      { validTo: null },
      { validTo: { gt: asOf } },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Mutation.upsertReportDatapoints
// ────────────────────────────────────────────────────────────────────

describe("Mutation.upsertReportDatapoints", () => {
  const validInput = {
    reportId: "r1",
    reportTitle: "Sudan sitrep",
    sourceUrl: "https://…",
    publishedAt: new Date("2026-07-10T00:00:00Z"),
    reportingPeriodStart: null,
    reportingPeriodEnd: new Date("2026-07-05T00:00:00Z"),
    locationIds: ["sd0201"],
    locationPcodes: [],
    eventTypes: ["conflict"],
    totalAffected: null,
    totalDisplaced: 40000,
    totalKilled: 5,
    data: { casualties: {} } as unknown as Parameters<
      typeof upsertReportDatapoints
    >[1]["input"]["data"],
    schemaVersion: "v1",
    extractedByModel: "claude-sonnet-4-6",
  };

  it("rejects viewer role via requireRole", async () => {
    const ctx = buildContext(VIEWER, {});
    await expect(
      upsertReportDatapoints(null, { input: validInput }, ctx),
    ).rejects.toThrow(GraphQLError);
  });

  it("rejects empty reportId with BAD_USER_INPUT", async () => {
    const ctx = buildContext(ADMIN, {});
    const badInput = { ...validInput, reportId: "" };
    await expect(
      upsertReportDatapoints(null, { input: badInput }, ctx),
    ).rejects.toThrow(GraphQLError);
  });

  it("createdOrReplaced=false when no prior row exists", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const upsert = vi.fn().mockResolvedValue({ id: "r1" });
    const ctx = buildContext(PIPELINE, {
      reportDatapoint: { findUnique, upsert },
    });
    const result = await upsertReportDatapoints(
      null, { input: validInput }, ctx,
    );
    expect(result).toEqual({
      reportId: "r1",
      schemaVersion: "v1",
      createdOrReplaced: false,
    });
  });

  it("createdOrReplaced=true when a prior row exists", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "existing" });
    const upsert = vi.fn().mockResolvedValue({ id: "existing" });
    const ctx = buildContext(PIPELINE, {
      reportDatapoint: { findUnique, upsert },
    });
    const result = await upsertReportDatapoints(
      null, { input: validInput }, ctx,
    );
    expect(result.createdOrReplaced).toBe(true);
    // extractedAt should be refreshed on updates so the reviewer-
    // audit workflow can filter "extracted in the last N days".
    expect(upsert.mock.calls[0]![0].update.extractedAt).toBeInstanceOf(Date);
  });
});

// ────────────────────────────────────────────────────────────────────
// Mutation.refreshAggregatedDatapoints
// ────────────────────────────────────────────────────────────────────

describe("Mutation.refreshAggregatedDatapoints", () => {
  const args = {
    from: new Date("2026-04-01T00:00:00Z"),
    to: new Date("2026-07-10T00:00:00Z"),
    schemaVersion: "v1",
  };

  it("rejects non-pipeline callers", async () => {
    const ctx = buildContext(VIEWER, {});
    await expect(
      refreshAggregatedDatapoints(null, args, ctx),
    ).rejects.toThrow(GraphQLError);
  });

  it("returns zeroes when no reports in window", async () => {
    const ctx = buildContext(PIPELINE, {
      reportDatapoint: { findMany: vi.fn().mockResolvedValue([]) },
      locations: { findMany: vi.fn() },
      aggregatedDatapoint: {
        updateMany: vi.fn(), create: vi.fn(),
      },
      $transaction: vi.fn(),
    });
    const result = await refreshAggregatedDatapoints(null, args, ctx);
    expect(result).toEqual({
      computedBuckets: 0, supersededBuckets: 0, schemaVersion: "v1",
    });
  });

  it("walks four tiers per report via hierarchy resolution", async () => {
    // One report in Kordofan (A2 SD0701) → contributes to weekly-A2,
    // monthly-A1 (parent SDN10), yearly-country (SDN0), all-time-country.
    // That's 4 distinct bucket keys per report.
    const findManyReports = vi.fn().mockResolvedValue([
      {
        id: "row1",
        reportId: "r1",
        publishedAt: new Date("2026-07-10T00:00:00Z"),
        reportingPeriodStart: null,
        reportingPeriodEnd: new Date("2026-07-08T00:00:00Z"),
        locationIds: ["sd0701"],
        data: {
          casualties: {
            killed: {
              total: {
                value: 3, unit: "people", confidence: "reported",
                source_quote: "…", chunk_index: 0, page_number: 1,
              },
            },
          },
        },
      },
    ]);
    // First locations.findMany: {sd0701} — its ancestorIds chain
    // walks up through the A1 and A0.
    // Second locations.findMany: the ancestor rows so we can label
    // each by its `level` field.
    const findManyLocations = vi.fn()
      .mockResolvedValueOnce([
        { id: "sd0701", level: 2, ancestorIds: ["sdn10", "sdn0"] },
      ])
      .mockResolvedValueOnce([
        { id: "sdn10", level: 1 },
        { id: "sdn0", level: 0 },
      ]);
    // Transaction body is invoked with a tx handle; stub it so
    // updateMany/create record into per-tx handles as expected.
    const updateManyTx = vi.fn().mockResolvedValue({ count: 0 });
    const createTx = vi.fn().mockResolvedValue({});
    const transactionRun = vi.fn().mockImplementation(async (cb) => {
      await cb({
        aggregatedDatapoint: { updateMany: updateManyTx, create: createTx },
      });
    });
    const ctx = buildContext(PIPELINE, {
      reportDatapoint: { findMany: findManyReports },
      locations: { findMany: findManyLocations },
      $transaction: transactionRun,
    });

    const result = await refreshAggregatedDatapoints(null, args, ctx);
    // 4 tiers × 1 report = 4 bucket create calls
    expect(createTx).toHaveBeenCalledTimes(4);
    expect(result.computedBuckets).toBe(4);
    expect(result.schemaVersion).toBe("v1");

    // Verify the window kinds materialised are the four we expect —
    // any regression that stops emitting one of the tiers should
    // surface here.
    const windowKinds = createTx.mock.calls
      .map((c) => (c[0] as { data: { windowKind: string } }).data.windowKind)
      .sort();
    expect(windowKinds).toEqual(["all", "monthly", "weekly", "yearly"]);
  });
});
