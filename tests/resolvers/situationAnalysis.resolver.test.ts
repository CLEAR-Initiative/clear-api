/**
 * Unit tests for `situationAnalysis.resolver.ts`.
 *
 * DB-FREE: every Prisma delegate the resolver touches is a `vi.fn()`
 * stub. No real database. Focus on the branches that matter for the
 * dashboard read path + the bitemporal write path:
 *
 *   Query.situationAnalysis            — auth gate, year → calendar
 *                                        window derivation, cache-hit
 *                                        vs no-row-null, asOf filter.
 *   Query.situationAnalysesForCountry  — auth gate, limit clamping,
 *                                        current-only filter.
 *   Mutation.upsertSituationAnalysis   — role gate, empty-id
 *                                        BAD_USER_INPUT,
 *                                        supersede-before-insert
 *                                        ordering,
 *                                        `supersededPrevious` flag.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";

import { situationAnalysisResolvers } from "../../src/resolvers/situationAnalysis.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    // `unknown` shim — same reason as the datapoint resolver tests.
    // PrismaClient's generated shape doesn't overlap with a stub map,
    // so the direct cast trips the strict-overlap check.
    prisma: prisma as unknown as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
    locale: "en",
  } as Context;
}

const {
  situationAnalysis,
  situationAnalysesForCountry,
} = situationAnalysisResolvers.Query;
const {
  upsertSituationAnalysis,
} = situationAnalysisResolvers.Mutation;

const VIEWER = { id: "u1", role: "viewer" };
const PIPELINE = { id: "u2", role: "pipeline" };
const ADMIN = { id: "u3", role: "admin" };
const PENDING = { id: "u4", role: "pending" };

// ────────────────────────────────────────────────────────────────────
// Query.situationAnalysis
// ────────────────────────────────────────────────────────────────────

describe("Query.situationAnalysis", () => {
  it("rejects pending users via requireContentReader", async () => {
    const ctx = buildContext(PENDING, {
      situationAnalysis: { findFirst: vi.fn() },
    });
    await expect(
      situationAnalysis(null, { countryLocationId: "sudan" }, ctx),
    ).rejects.toThrow(GraphQLError);
  });

  it("derives Jan 1 → Dec 31 UTC window from `year`", async () => {
    // The dashboard passes year=2026 and expects the server to
    // expand into a calendar window. Test the derivation is UTC and
    // covers the whole year.
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, { situationAnalysis: { findFirst } });
    await situationAnalysis(
      null, { countryLocationId: "sudan", year: 2026 }, ctx,
    );
    const call = findFirst.mock.calls[0]![0];
    const start = call.where.windowStart as Date;
    const end = call.where.windowEnd as Date;
    expect(start.getUTCFullYear()).toBe(2026);
    expect(start.getUTCMonth()).toBe(0);
    expect(start.getUTCDate()).toBe(1);
    expect(end.getUTCFullYear()).toBe(2026);
    expect(end.getUTCMonth()).toBe(11);
    expect(end.getUTCDate()).toBe(31);
  });

  it("defaults `year` to now.getUTCFullYear() when omitted", async () => {
    // Most dashboard calls omit the year — server picks "current".
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, { situationAnalysis: { findFirst } });
    await situationAnalysis(null, { countryLocationId: "sudan" }, ctx);
    const call = findFirst.mock.calls[0]![0];
    const start = call.where.windowStart as Date;
    // Whatever "this year" is at test time — check it matches now.
    expect(start.getUTCFullYear()).toBe(new Date().getUTCFullYear());
  });

  it("returns the cached row when one matches", async () => {
    const cached = {
      id: "sit-1",
      countryLocationId: "sudan",
      windowStart: new Date("2026-01-01T00:00:00Z"),
      windowEnd: new Date("2026-12-31T23:59:59Z"),
      data: { datapoints: { population_displaced: 6_500_000 } },
      sourceReportIds: ["r-1"],
      generatedByModel: "claude-sonnet-4-6",
      generatedAt: new Date(),
      validFrom: new Date(),
      validTo: null,
      schemaVersion: "v1",
    };
    const findFirst = vi.fn().mockResolvedValue(cached);
    const ctx = buildContext(VIEWER, { situationAnalysis: { findFirst } });
    const result = await situationAnalysis(
      null, { countryLocationId: "sudan", year: 2026 }, ctx,
    );
    expect(result).toEqual(cached);
  });

  it("defaults to the newest write when no schema version is asked for", async () => {
    // The pipeline owns SCHEMA_VERSION and bumps it independently. A
    // constant here would keep writes succeeding while every read
    // returned null: an empty dashboard, no signal, until this repo
    // redeployed. Versions coexist (the uniqueness index is per-version),
    // so validFrom desc picks the most recent write and the client reads
    // schemaVersion off the row.
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, { situationAnalysis: { findFirst } });
    await situationAnalysis(
      null, { countryLocationId: "sudan", year: 2026 }, ctx,
    );
    const call = findFirst.mock.calls[0]![0];
    expect(call.where).not.toHaveProperty("schemaVersion");
    expect(call.orderBy).toEqual({ validFrom: "desc" });
  });

  it("pins to the requested schema version when the caller asks", async () => {
    // Older versions stay valid alongside newer ones — a client on the v1
    // payload shape must be able to keep reading v1 after v2 lands.
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, { situationAnalysis: { findFirst } });
    await situationAnalysis(
      null, { countryLocationId: "sudan", year: 2026, schemaVersion: "v1" }, ctx,
    );
    expect(findFirst.mock.calls[0]![0].where.schemaVersion).toBe("v1");
  });

  it("returns null when no row matches (dashboard renders empty state)", async () => {
    // Between an invalidation cascade and the next regen, no current
    // row exists. Dashboard shows empty rather than a stale value.
    const ctx = buildContext(VIEWER, {
      situationAnalysis: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const result = await situationAnalysis(
      null, { countryLocationId: "sudan", year: 2026 }, ctx,
    );
    expect(result).toBeNull();
  });

  it("applies asOf filter for historical reads", async () => {
    // `asOf` = last Wednesday means "give me the row that was current
    // at that moment". validFrom<=asOf AND (validTo IS NULL OR validTo>asOf).
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, { situationAnalysis: { findFirst } });
    const asOf = new Date("2026-06-01T12:00:00Z");
    await situationAnalysis(
      null, { countryLocationId: "sudan", year: 2026, asOf }, ctx,
    );
    const where = findFirst.mock.calls[0]![0].where;
    expect(where.validFrom).toEqual({ lte: asOf });
    expect(where.OR).toEqual([
      { validTo: null }, { validTo: { gt: asOf } },
    ]);
  });

  it("orders by validFrom desc to defensively pick the newest in overlap", async () => {
    // Two rows momentarily overlapping (mid-transaction race) — the
    // resolver picks the most recently-inserted. Guards against a
    // race we don't expect but can't fully prevent.
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, { situationAnalysis: { findFirst } });
    await situationAnalysis(
      null, { countryLocationId: "sudan", year: 2026 }, ctx,
    );
    const call = findFirst.mock.calls[0]![0];
    expect(call.orderBy).toEqual({ validFrom: "desc" });
  });
});

// ────────────────────────────────────────────────────────────────────
// Query.situationAnalysesForCountry
// ────────────────────────────────────────────────────────────────────

describe("Query.situationAnalysesForCountry", () => {
  it("rejects pending users", async () => {
    const ctx = buildContext(PENDING, {
      situationAnalysis: { findMany: vi.fn() },
    });
    await expect(
      situationAnalysesForCountry(null, { countryLocationId: "sudan" }, ctx),
    ).rejects.toThrow(GraphQLError);
  });

  /** The trend view resolves its schema version from the newest current
   *  row before querying, so every test here needs that probe stubbed. */
  function trendCtx(role: typeof VIEWER, schemaVersion: string | null = "v1") {
    const findMany = vi.fn().mockResolvedValue([]);
    const findFirst = vi.fn().mockResolvedValue(
      schemaVersion === null ? null : { schemaVersion },
    );
    return { ctx: buildContext(role, { situationAnalysis: { findMany, findFirst } }), findMany, findFirst };
  }

  it("filters to current-version rows only", async () => {
    const { ctx, findMany } = trendCtx(VIEWER);
    await situationAnalysesForCountry(
      null, { countryLocationId: "sudan" }, ctx,
    );
    const call = findMany.mock.calls[0]![0];
    expect(call.where.validTo).toBeNull();
  });

  it("resolves the trend's schema version from the newest current row", async () => {
    // Guards the cross-repo failure mode: the pipeline owns SCHEMA_VERSION
    // and bumps independently. Pinning a constant here meant a bump left
    // writes succeeding while the chart silently emptied.
    const { ctx, findMany, findFirst } = trendCtx(VIEWER, "v2");
    await situationAnalysesForCountry(
      null, { countryLocationId: "sudan" }, ctx,
    );
    expect(findFirst.mock.calls[0]![0].orderBy).toEqual({ validFrom: "desc" });
    expect(findMany.mock.calls[0]![0].where.schemaVersion).toBe("v2");
  });

  it("never mixes schema versions on a trend", async () => {
    // A chart spanning v1 and v2 rows would plot two different quantities
    // as one series. Exactly one version must reach the query.
    const { ctx, findMany } = trendCtx(VIEWER, "v3");
    await situationAnalysesForCountry(
      null, { countryLocationId: "sudan" }, ctx,
    );
    expect(findMany.mock.calls[0]![0].where.schemaVersion).toBe("v3");
  });

  it("pins the trend to the requested version without probing", async () => {
    // Caller asked for v1 explicitly — chart the older payload shape and
    // skip the newest-version lookup entirely.
    const { ctx, findMany, findFirst } = trendCtx(VIEWER, "v2");
    await situationAnalysesForCountry(
      null, { countryLocationId: "sudan", schemaVersion: "v1" }, ctx,
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0]![0].where.schemaVersion).toBe("v1");
  });

  it("returns empty without querying when the country has no current rows", async () => {
    const { ctx, findMany } = trendCtx(VIEWER, null);
    const result = await situationAnalysesForCountry(
      null, { countryLocationId: "sudan" }, ctx,
    );
    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("clamps limit between 1 and 20", async () => {
    const { ctx, findMany } = trendCtx(VIEWER);
    // Well above the ceiling → clamped to 20.
    await situationAnalysesForCountry(
      null, { countryLocationId: "sudan", limit: 500 }, ctx,
    );
    expect(findMany.mock.calls[0]![0].take).toBe(20);
    // Zero / negative → clamped to 1.
    await situationAnalysesForCountry(
      null, { countryLocationId: "sudan", limit: 0 }, ctx,
    );
    expect(findMany.mock.calls[1]![0].take).toBe(1);
    await situationAnalysesForCountry(
      null, { countryLocationId: "sudan", limit: -5 }, ctx,
    );
    expect(findMany.mock.calls[2]![0].take).toBe(1);
  });

  it("defaults limit to 5 when omitted", async () => {
    const { ctx, findMany } = trendCtx(VIEWER);
    await situationAnalysesForCountry(
      null, { countryLocationId: "sudan" }, ctx,
    );
    expect(findMany.mock.calls[0]![0].take).toBe(5);
  });

  it("orders windowStart desc (newest year first)", async () => {
    const { ctx, findMany } = trendCtx(VIEWER);
    await situationAnalysesForCountry(
      null, { countryLocationId: "sudan" }, ctx,
    );
    expect(findMany.mock.calls[0]![0].orderBy).toEqual({ windowStart: "desc" });
  });
});

// ────────────────────────────────────────────────────────────────────
// Mutation.upsertSituationAnalysis
// ────────────────────────────────────────────────────────────────────

describe("Mutation.upsertSituationAnalysis", () => {
  const validInput = {
    countryLocationId: "sudan-a0",
    windowStart: new Date("2026-01-01T00:00:00Z"),
    windowEnd: new Date("2026-12-31T23:59:59Z"),
    data: { datapoints: { population_displaced: 6_500_000 } } as any,
    sourceReportIds: ["r-1", "r-2"],
    aggregatedDatapointId: "agg-abc",
    generatedByModel: "claude-sonnet-4-6",
    generationCostUsd: 0.42,
    schemaVersion: "v1",
  };

  it("rejects viewer role via requireRole", async () => {
    const ctx = buildContext(VIEWER, {});
    await expect(
      upsertSituationAnalysis(null, { input: validInput }, ctx),
    ).rejects.toThrow(GraphQLError);
  });

  it("rejects empty countryLocationId with BAD_USER_INPUT", async () => {
    const ctx = buildContext(PIPELINE, {});
    const badInput = { ...validInput, countryLocationId: "" };
    await expect(
      upsertSituationAnalysis(null, { input: badInput }, ctx),
    ).rejects.toThrow(GraphQLError);
  });

  it("rejects empty schemaVersion with BAD_USER_INPUT", async () => {
    const ctx = buildContext(PIPELINE, {});
    const badInput = { ...validInput, schemaVersion: "" };
    await expect(
      upsertSituationAnalysis(null, { input: badInput }, ctx),
    ).rejects.toThrow(GraphQLError);
  });

  it("stamps previous current row BEFORE inserting the new one", async () => {
    // Bitemporal invariant: the partial unique index rejects the
    // insert unless the prior current row is already superseded.
    // Ordering matters — this test locks it in.
    const opOrder: string[] = [];
    const updateManyTx = vi.fn().mockImplementation(async () => {
      opOrder.push("updateMany");
      return { count: 1 };
    });
    const createTx = vi.fn().mockImplementation(async () => {
      opOrder.push("create");
      return { id: "sit-new", countryLocationId: "sudan-a0" };
    });
    const ctx = buildContext(PIPELINE, {
      $transaction: vi.fn().mockImplementation(async (cb) => {
        return cb({
          situationAnalysis: { updateMany: updateManyTx, create: createTx },
        });
      }),
    });

    const result = await upsertSituationAnalysis(
      null, { input: validInput }, ctx,
    );

    expect(opOrder).toEqual(["updateMany", "create"]);
    expect(result.supersededPrevious).toBe(true);
    expect(result.situationAnalysisId).toBe("sit-new");
    expect(result.countryLocationId).toBe("sudan-a0");
  });

  it("supersededPrevious=false when no prior current row existed", async () => {
    // First-time write for this (country, window) — updateMany
    // matches zero rows; the row still lands cleanly.
    const ctx = buildContext(PIPELINE, {
      $transaction: vi.fn().mockImplementation(async (cb) => {
        return cb({
          situationAnalysis: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: vi.fn().mockResolvedValue({
              id: "sit-fresh", countryLocationId: "sudan-a0",
            }),
          },
        });
      }),
    });
    const result = await upsertSituationAnalysis(
      null, { input: validInput }, ctx,
    );
    expect(result.supersededPrevious).toBe(false);
  });

  it("supersede filter targets the same bucket key + version", async () => {
    // If the filter drifts (e.g. drops schemaVersion), an old row of
    // a different version would collide with the partial unique
    // index. This test locks the filter shape.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const create = vi.fn().mockResolvedValue({
      id: "sit-x", countryLocationId: "sudan-a0",
    });
    const ctx = buildContext(PIPELINE, {
      $transaction: vi.fn().mockImplementation(async (cb) => {
        return cb({
          situationAnalysis: { updateMany, create },
        });
      }),
    });
    await upsertSituationAnalysis(null, { input: validInput }, ctx);

    const where = updateMany.mock.calls[0]![0].where;
    expect(where.countryLocationId).toBe("sudan-a0");
    expect(where.windowStart).toEqual(validInput.windowStart);
    expect(where.windowEnd).toEqual(validInput.windowEnd);
    expect(where.schemaVersion).toBe("v1");
    expect(where.validTo).toBeNull();
  });

  it("admin role passes the requireRole gate (equivalent to pipeline)", async () => {
    // Confirm admin also passes — the mutation isn't pipeline-only.
    const ctx = buildContext(ADMIN, {
      $transaction: vi.fn().mockImplementation(async (cb) => {
        return cb({
          situationAnalysis: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: vi.fn().mockResolvedValue({
              id: "sit-a", countryLocationId: "sudan-a0",
            }),
          },
        });
      }),
    });
    const result = await upsertSituationAnalysis(
      null, { input: validInput }, ctx,
    );
    expect(result.situationAnalysisId).toBe("sit-a");
  });

  it("null aggregatedDatapointId + null generationCostUsd flow through", async () => {
    // Early / deterministic-only runs have no aggregation linkage +
    // no LLM cost — both must be settable to null without erroring.
    const create = vi.fn().mockResolvedValue({
      id: "sit-early", countryLocationId: "sudan-a0",
    });
    const ctx = buildContext(PIPELINE, {
      $transaction: vi.fn().mockImplementation(async (cb) => {
        return cb({
          situationAnalysis: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create,
          },
        });
      }),
    });
    await upsertSituationAnalysis(null, {
      input: { ...validInput, aggregatedDatapointId: null, generationCostUsd: null },
    }, ctx);
    const created = create.mock.calls[0]![0].data;
    expect(created.aggregatedDatapointId).toBeNull();
    expect(created.generationCostUsd).toBeNull();
  });
});
