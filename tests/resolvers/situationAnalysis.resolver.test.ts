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

  it("derives Jan 1 UTC from `year` and keys on windowKind", async () => {
    // The dashboard passes year=2026 and expects the server to expand it.
    // Only the START is derived: the bucket key is
    // (country, windowKind, windowStart).
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, { situationAnalysis: { findFirst } });
    await situationAnalysis(
      null, { countryLocationId: "sudan", year: 2026 }, ctx,
    );
    const call = findFirst.mock.calls[0]![0];
    const start = call.where.windowStart as Date;
    expect(start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(call.where.windowKind).toBe("yearly");
  });

  it("never matches on windowEnd", async () => {
    // REGRESSION GUARD. The pipeline builds the window in Python
    // (23:59:59.000) and this resolver used to build it in TS
    // (23:59:59.999). Prisma's bare-value `where` is exact equality, so
    // the 999ms gap meant every read returned null while every write
    // succeeded — a permanently empty dashboard with nothing erroring.
    // windowEnd is a derived detail; it must never key a read.
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(VIEWER, { situationAnalysis: { findFirst } });
    await situationAnalysis(
      null, { countryLocationId: "sudan", year: 2026 }, ctx,
    );
    expect(findFirst.mock.calls[0]![0].where).not.toHaveProperty("windowEnd");
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
    // Deliberately .000, matching what the Python writer actually sends
    // (`datetime(y, 12, 31, 23, 59, 59)`). It must stay that way: this
    // fixture is the canary for the bug where the resolver looked for
    // .999 and no read ever matched. windowEnd is never keyed on now.
    windowEnd: new Date("2026-12-31T23:59:59Z"),
    windowKind: "yearly",
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

  it("supersede filter matches the partial unique index exactly", async () => {
    // The filter must be the index's key —
    // (country, windowKind, windowStart, schemaVersion) WHERE valid_to IS
    // NULL. Too narrow and the prior row isn't stamped, so the insert
    // collides with it; too broad and it supersedes rows of another
    // version or granularity. This test locks the shape.
    //
    // windowEnd is deliberately ABSENT: it is a derived detail, and
    // including it would mean a writer whose end-of-day shifted by a
    // millisecond failed to supersede its own previous row.
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
    expect(where.windowKind).toBe("yearly");
    expect(where.windowStart).toEqual(validInput.windowStart);
    expect(where.schemaVersion).toBe("v1");
    expect(where.validTo).toBeNull();
    expect(where).not.toHaveProperty("windowEnd");
  });

  it("rejects a missing windowKind rather than defaulting it", async () => {
    // windowKind keys the bucket. Defaulting a missing one would write a
    // row under a granularity the caller never meant, which no reader
    // would then ask for — a silent write to nowhere.
    const ctx = buildContext(PIPELINE, {
      $transaction: vi.fn(),
    });
    const { windowKind: _omitted, ...withoutKind } = validInput;
    await expect(
      upsertSituationAnalysis(null, { input: withoutKind as any }, ctx),
    ).rejects.toThrow(GraphQLError);
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
