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

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";

import { datapointResolvers } from "../../src/resolvers/datapoint.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    // `unknown` shim — the generated PrismaClient shape is huge and
    // stub tests only touch a couple of delegates; casting directly
    // through `Context["prisma"]` trips the newer strict overlap
    // check. Same pattern crisis.resolver.test.ts and friends use.
    prisma: prisma as unknown as Context["prisma"],
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
      computedBuckets: 0,
      supersededBuckets: 0,
      situationAnalysesInvalidated: 0,
      schemaVersion: "v1",
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
    // Also stub situationAnalysis.updateMany — the yearly-country
    // bucket iteration now cascades to it.
    const updateManyTx = vi.fn().mockResolvedValue({ count: 0 });
    const createTx = vi.fn().mockResolvedValue({});
    const situationUpdateManyTx = vi.fn().mockResolvedValue({ count: 0 });
    const transactionRun = vi.fn().mockImplementation(async (cb) => {
      await cb({
        aggregatedDatapoint: { updateMany: updateManyTx, create: createTx },
        situationAnalysis: { updateMany: situationUpdateManyTx },
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

  it("supersedes any current row BEFORE inserting the new one", async () => {
    // Bitemporal invariant: `updateMany(validTo=now)` on the current
    // row MUST run before the `create` of the fresh row. Otherwise
    // the partial unique index (WHERE valid_to IS NULL) rejects the
    // insert. This test locks that ordering per bucket.
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
    const findManyLocations = vi.fn()
      .mockResolvedValueOnce([
        { id: "sd0701", level: 2, ancestorIds: ["sdn10", "sdn0"] },
      ])
      .mockResolvedValueOnce([
        { id: "sdn10", level: 1 }, { id: "sdn0", level: 0 },
      ]);

    // Order of operations tracker — every mock records into it so we
    // can assert supersede-before-insert per bucket.
    const opOrder: string[] = [];
    const updateManyTx = vi.fn().mockImplementation(async () => {
      opOrder.push("updateMany");
      // Simulate a previously-current row being superseded.
      return { count: 1 };
    });
    const createTx = vi.fn().mockImplementation(async () => {
      opOrder.push("create");
      return {};
    });
    // situation_analysis cascade is unrelated to the ordering
    // assertion — stub with a no-op so the resolver's yearly-tier
    // branch has something to call.
    const situationUpdateManyTx = vi.fn().mockResolvedValue({ count: 0 });
    const transactionRun = vi.fn().mockImplementation(async (cb) => {
      await cb({
        aggregatedDatapoint: { updateMany: updateManyTx, create: createTx },
        situationAnalysis: { updateMany: situationUpdateManyTx },
      });
    });
    const ctx = buildContext(PIPELINE, {
      reportDatapoint: { findMany: findManyReports },
      locations: { findMany: findManyLocations },
      $transaction: transactionRun,
    });

    const result = await refreshAggregatedDatapoints(null, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-07-10T00:00:00Z"),
      schemaVersion: "v1",
    }, ctx);

    // 4 buckets × (1 updateMany + 1 create) = 8 total ops, alternating.
    expect(opOrder).toEqual([
      "updateMany", "create", "updateMany", "create",
      "updateMany", "create", "updateMany", "create",
    ]);
    // supersededBuckets sums the updateMany counts (1 per tier).
    expect(result.supersededBuckets).toBe(4);
    expect(result.computedBuckets).toBe(4);
  });

  it("skips higher tiers when a report location has no A0/A1 ancestor", async () => {
    // Location with level=4 (point) and NO A0/A1/A2 ancestor. Should
    // NOT crash — just produces zero buckets (nothing to attribute
    // the report to). Defensive against orphan locations in the tree.
    const findManyReports = vi.fn().mockResolvedValue([
      {
        id: "row-orphan",
        reportId: "r-orphan",
        publishedAt: new Date("2026-07-10T00:00:00Z"),
        reportingPeriodStart: null,
        reportingPeriodEnd: new Date("2026-07-08T00:00:00Z"),
        locationIds: ["orphan-l4"],
        data: {},
      },
    ]);
    const findManyLocations = vi.fn()
      .mockResolvedValueOnce([
        // Level=4 point with no ancestors — an orphaned test/legacy row.
        { id: "orphan-l4", level: 4, ancestorIds: [] },
      ])
      .mockResolvedValueOnce([]);

    const createTx = vi.fn().mockResolvedValue({});
    const updateManyTx = vi.fn().mockResolvedValue({ count: 0 });
    const ctx = buildContext(PIPELINE, {
      reportDatapoint: { findMany: findManyReports },
      locations: { findMany: findManyLocations },
      $transaction: vi.fn().mockImplementation(async (cb) => {
        await cb({
          aggregatedDatapoint: { updateMany: updateManyTx, create: createTx },
        });
      }),
    });

    const result = await refreshAggregatedDatapoints(null, {
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-15T00:00:00Z"),
      schemaVersion: "v1",
    }, ctx);

    // No buckets: level=4 has no A0/A1/A2 ancestor to attribute to.
    expect(result.computedBuckets).toBe(0);
    expect(createTx).not.toHaveBeenCalled();
  });

  it("cascades validTo on situation_analyses for yearly-country buckets only", async () => {
    // The refresh mutation writes four tiers. Only the yearly-country
    // tier should trigger the situation_analyses cascade — weekly-A2
    // / monthly-A1 changes must NOT invalidate the yearly snapshot
    // until they roll up. Locks the cascade guard from the resolver.
    const findManyReports = vi.fn().mockResolvedValue([
      {
        id: "row1", reportId: "r1",
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
    const findManyLocations = vi.fn()
      .mockResolvedValueOnce([
        { id: "sd0701", level: 2, ancestorIds: ["sdn10", "sdn0"] },
      ])
      .mockResolvedValueOnce([
        { id: "sdn10", level: 1 }, { id: "sdn0", level: 0 },
      ]);

    // Track every situation_analysis.updateMany call — we assert
    // it fires only inside yearly-country iterations.
    const situationUpdateCalls: Array<Record<string, unknown>> = [];

    const ctx = buildContext(PIPELINE, {
      reportDatapoint: { findMany: findManyReports },
      locations: { findMany: findManyLocations },
      $transaction: vi.fn().mockImplementation(async (cb) => {
        await cb({
          aggregatedDatapoint: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: vi.fn().mockResolvedValue({}),
          },
          situationAnalysis: {
            updateMany: vi.fn().mockImplementation(async (args) => {
              situationUpdateCalls.push(args.where as Record<string, unknown>);
              return { count: 1 };
            }),
          },
        });
      }),
    });

    const result = await refreshAggregatedDatapoints(null, {
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-12-31T00:00:00Z"),
      schemaVersion: "v1",
    }, ctx);

    // Only ONE situation_analyses cascade — the yearly-country tier.
    // The other three (weekly-A2, monthly-A1, all-time-country)
    // should NOT trigger it. all-time-country has locationId non-
    // null so it COULD trigger but shouldn't — the resolver guards
    // with `windowKind === "yearly"`.
    expect(situationUpdateCalls).toHaveLength(1);
    expect(situationUpdateCalls[0]!.countryLocationId).toBe("sdn0");
    expect(situationUpdateCalls[0]!.validTo).toBeNull();

    // The result carries the invalidation count back to the caller
    // (Dagster surfaces it as an asset metadata field).
    expect(result.situationAnalysesInvalidated).toBe(1);
    // Bucket write counts unchanged.
    expect(result.computedBuckets).toBe(4);
  });

  it("cascade skips when no situation_analysis current row exists yet", async () => {
    // Fresh env — no situation_analyses row for (country, year) yet.
    // The yearly-country bucket write still succeeds; updateMany
    // returns count=0; `situationAnalysesInvalidated` = 0.
    const findManyReports = vi.fn().mockResolvedValue([
      {
        id: "row1", reportId: "r1",
        publishedAt: new Date("2026-07-10T00:00:00Z"),
        reportingPeriodStart: null,
        reportingPeriodEnd: new Date("2026-07-08T00:00:00Z"),
        locationIds: ["sd0701"],
        data: {},
      },
    ]);
    const findManyLocations = vi.fn()
      .mockResolvedValueOnce([
        { id: "sd0701", level: 2, ancestorIds: ["sdn10", "sdn0"] },
      ])
      .mockResolvedValueOnce([
        { id: "sdn10", level: 1 }, { id: "sdn0", level: 0 },
      ]);

    const ctx = buildContext(PIPELINE, {
      reportDatapoint: { findMany: findManyReports },
      locations: { findMany: findManyLocations },
      $transaction: vi.fn().mockImplementation(async (cb) => {
        await cb({
          aggregatedDatapoint: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: vi.fn().mockResolvedValue({}),
          },
          situationAnalysis: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        });
      }),
    });

    const result = await refreshAggregatedDatapoints(null, {
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-12-31T00:00:00Z"),
      schemaVersion: "v1",
    }, ctx);

    expect(result.situationAnalysesInvalidated).toBe(0);
    expect(result.computedBuckets).toBe(4);
  });

  it("shared parent A1 collapses into one monthly-A1 bucket across A2 siblings", async () => {
    // Two reports touching two A2 siblings that share the same A1
    // parent + same country. Weekly-A2 tier gets 2 buckets (one per
    // A2), but monthly-A1 / yearly-country / all-time-country should
    // collapse — only one bucket per shared parent per window.
    const findManyReports = vi.fn().mockResolvedValue([
      {
        id: "row1", reportId: "r1",
        publishedAt: new Date("2026-07-10T00:00:00Z"),
        reportingPeriodStart: null,
        reportingPeriodEnd: new Date("2026-07-08T00:00:00Z"),
        locationIds: ["sd0701"],
        data: {},
      },
      {
        id: "row2", reportId: "r2",
        publishedAt: new Date("2026-07-11T00:00:00Z"),
        reportingPeriodStart: null,
        reportingPeriodEnd: new Date("2026-07-09T00:00:00Z"),
        locationIds: ["sd0702"], // sibling A2 under same A1
        data: {},
      },
    ]);
    const findManyLocations = vi.fn()
      .mockResolvedValueOnce([
        { id: "sd0701", level: 2, ancestorIds: ["sdn10", "sdn0"] },
        { id: "sd0702", level: 2, ancestorIds: ["sdn10", "sdn0"] },
      ])
      .mockResolvedValueOnce([
        { id: "sdn10", level: 1 }, { id: "sdn0", level: 0 },
      ]);

    const createTx = vi.fn().mockResolvedValue({});
    const ctx = buildContext(PIPELINE, {
      reportDatapoint: { findMany: findManyReports },
      locations: { findMany: findManyLocations },
      $transaction: vi.fn().mockImplementation(async (cb) => {
        await cb({
          aggregatedDatapoint: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: createTx,
          },
          situationAnalysis: {
            // Yearly-country iterations cascade to this; no-op is
            // fine for the collapse-count assertions below.
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        });
      }),
    });

    await refreshAggregatedDatapoints(null, {
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-15T00:00:00Z"),
      schemaVersion: "v1",
    }, ctx);

    const bucketsByKind: Record<string, Set<string>> = {
      weekly: new Set(), monthly: new Set(), yearly: new Set(), all: new Set(),
    };
    for (const call of createTx.mock.calls) {
      const d = (call[0] as { data: { windowKind: string; locationId: string } }).data;
      bucketsByKind[d.windowKind]?.add(d.locationId);
    }
    // Both siblings write to their own weekly bucket — 2 distinct A2s.
    expect(bucketsByKind.weekly!.size).toBe(2);
    // But the shared parents collapse to one bucket each.
    expect(bucketsByKind.monthly!.size).toBe(1);
    expect(bucketsByKind.yearly!.size).toBe(1);
    expect(bucketsByKind.all!.size).toBe(1);
  });
});
