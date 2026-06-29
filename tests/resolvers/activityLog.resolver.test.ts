/**
 * Unit tests for `activityLog.resolver.ts`.
 *
 * DB-free: every `context.prisma.*` delegate is stubbed with `vi.fn()`; no real
 * Prisma client is imported and `describeIfDb` is not used, so this suite runs
 * in CI without a database. The resolver has no external-service imports (only
 * the `Prisma` namespace type and the `requireRole` guard), so no `vi.mock` is
 * needed.
 *
 * Coverage:
 *   - Admin-only auth gate on all five queries (FORBIDDEN for non-admin,
 *     UNAUTHENTICATED when logged out).
 *   - activityLogs: limit clamp to MAX_LIMIT (500) + default 50, offset clamp
 *     to >= 0, and the full where-filter builder (userId, action, actionPrefix
 *     precedence, resourceType, from/to date range).
 *   - activityStats: default 30-day window, bucket aggregation (known actions
 *     map to named buckets, unknown actions only bump total), top-N user
 *     sorting, byDay ascending sort, deleted-user dropping, and the empty-rows
 *     short-circuit (no user lookup).
 *   - userEngagement: DAU/WAU/MAU window bounds, dauMauRatio percentage, and
 *     the divide-by-zero clamp.
 *   - dauSeries / mauSeries: row mapping (Date -> YYYY-MM-DD / YYYY-MM,
 *     bigint -> Number).
 *
 * Skipped (trivial, no branching): `ActivityLog.user` is a bare
 * `findUniqueOrThrow` passthrough on the FK with no logic to exercise.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { activityLogResolvers } from "../../src/resolvers/activityLog.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

/** Build a Context with the given user and a partial prisma stub. */
function buildContext(
  user: User,
  prisma: Record<string, unknown> = {},
): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const ADMIN: User = { id: "admin1", role: "admin" };
const VIEWER: User = { id: "u1", role: "viewer" };

const { activityLogs, activityStats, userEngagement, dauSeries, mauSeries } =
  activityLogResolvers.Query;

// ---------------------------------------------------------------------------
// Auth gate — applies identically to every query.
// ---------------------------------------------------------------------------

describe("admin-only auth gate", () => {
  const cases: Array<{ name: string; run: (ctx: Context) => unknown }> = [
    { name: "activityLogs", run: (ctx) => activityLogs(null, {}, ctx) },
    { name: "activityStats", run: (ctx) => activityStats(null, {}, ctx) },
    { name: "userEngagement", run: (ctx) => userEngagement(null, {}, ctx) },
    {
      name: "dauSeries",
      run: (ctx) => dauSeries(null, { from: "2026-01-01", to: "2026-02-01" }, ctx),
    },
    {
      name: "mauSeries",
      run: (ctx) => mauSeries(null, { from: "2026-01-01", to: "2026-02-01" }, ctx),
    },
  ];

  for (const { name, run } of cases) {
    it(`${name} throws FORBIDDEN for a non-admin`, async () => {
      await expect(run(buildContext(VIEWER))).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
    });

    it(`${name} throws UNAUTHENTICATED when logged out`, async () => {
      await expect(run(buildContext(null))).rejects.toMatchObject({
        extensions: { code: "UNAUTHENTICATED" },
      });
    });
  }
});

// ---------------------------------------------------------------------------
// activityLogs — pagination clamping + where-filter builder.
// ---------------------------------------------------------------------------

describe("Query.activityLogs", () => {
  function ctxWithFindMany(findMany: ReturnType<typeof vi.fn>) {
    return buildContext(ADMIN, { activityLogs: { findMany } });
  }

  it("defaults to limit 50 / offset 0 and an empty where", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(null, {}, ctxWithFindMany(findMany));
    expect(findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: "desc" },
      take: 50,
      skip: 0,
    });
  });

  it("clamps limit down to MAX_LIMIT (500)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(null, { limit: 10_000 }, ctxWithFindMany(findMany));
    expect(findMany.mock.calls[0][0].take).toBe(500);
  });

  it("honours a smaller explicit limit", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(null, { limit: 25 }, ctxWithFindMany(findMany));
    expect(findMany.mock.calls[0][0].take).toBe(25);
  });

  it("clamps a negative offset up to 0", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(null, { offset: -5 }, ctxWithFindMany(findMany));
    expect(findMany.mock.calls[0][0].skip).toBe(0);
  });

  it("passes a positive offset through", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(null, { offset: 120 }, ctxWithFindMany(findMany));
    expect(findMany.mock.calls[0][0].skip).toBe(120);
  });

  it("returns the rows from prisma unchanged", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const findMany = vi.fn().mockResolvedValue(rows);
    await expect(activityLogs(null, {}, ctxWithFindMany(findMany))).resolves.toBe(
      rows,
    );
  });

  it("builds where from userId / action / resourceType filters", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(
      null,
      { filter: { userId: "u9", action: "auth.login", resourceType: "alert" } },
      ctxWithFindMany(findMany),
    );
    expect(findMany.mock.calls[0][0].where).toEqual({
      userId: "u9",
      action: "auth.login",
      resourceType: "alert",
    });
  });

  it("actionPrefix produces a startsWith filter", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(
      null,
      { filter: { actionPrefix: "alert." } },
      ctxWithFindMany(findMany),
    );
    expect(findMany.mock.calls[0][0].where.action).toEqual({
      startsWith: "alert.",
    });
  });

  it("actionPrefix overrides an exact action (last write wins)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(
      null,
      { filter: { action: "auth.login", actionPrefix: "alert." } },
      ctxWithFindMany(findMany),
    );
    // The resolver assigns where.action twice; actionPrefix runs last.
    expect(findMany.mock.calls[0][0].where.action).toEqual({
      startsWith: "alert.",
    });
  });

  it("builds a createdAt range from both from and to", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(
      null,
      { filter: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" } },
      ctxWithFindMany(findMany),
    );
    const { createdAt } = findMany.mock.calls[0][0].where;
    expect(createdAt.gte).toBeInstanceOf(Date);
    expect(createdAt.gte.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(createdAt.lte.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("builds a createdAt range with only 'from' (no lte)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await activityLogs(
      null,
      { filter: { from: "2026-01-01T00:00:00.000Z" } },
      ctxWithFindMany(findMany),
    );
    const { createdAt } = findMany.mock.calls[0][0].where;
    expect(createdAt.gte).toBeInstanceOf(Date);
    expect(createdAt.lte).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// activityStats — aggregation, top-N, sorting, deleted-user handling.
// ---------------------------------------------------------------------------

describe("Query.activityStats", () => {
  /** Stub prisma for activityStats: log rows + a user lookup. */
  function statsCtx(
    rows: Array<{ userId: string; action: string; createdAt: Date }>,
    users: Array<{ id: string }> = [],
  ) {
    const logsFindMany = vi.fn().mockResolvedValue(rows);
    const userFindMany = vi.fn().mockResolvedValue(users);
    const ctx = buildContext(ADMIN, {
      activityLogs: { findMany: logsFindMany },
      user: { findMany: userFindMany },
    });
    return { ctx, logsFindMany, userFindMany };
  }

  it("queries the default 30-day trailing window over the tracked actions", async () => {
    const { ctx, logsFindMany } = statsCtx([]);
    const before = Date.now();
    await activityStats(null, {}, ctx);
    const after = Date.now();

    const where = logsFindMany.mock.calls[0][0].where;
    const to = where.createdAt.lte.getTime();
    const from = where.createdAt.gte.getTime();
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(after);
    // 30 days in ms.
    expect(to - from).toBe(30 * 86_400_000);
    expect(where.action.in).toContain("auth.login");
    expect(where.action.in).toContain("feedback.create");
  });

  it("honours explicit from/to bounds", async () => {
    const { ctx, logsFindMany } = statsCtx([]);
    const result = await activityStats(
      null,
      { from: "2026-01-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z" },
      ctx,
    );
    const where = logsFindMany.mock.calls[0][0].where;
    expect(where.createdAt.gte.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(where.createdAt.lte.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(result.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(result.to.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("skips the user lookup entirely when there are no rows", async () => {
    const { ctx, userFindMany } = statsCtx([]);
    const result = await activityStats(null, {}, ctx);
    expect(userFindMany).not.toHaveBeenCalled();
    expect(result.totals.total).toBe(0);
    expect(result.byUser).toEqual([]);
    expect(result.byDay).toEqual([]);
  });

  it("aggregates known actions into their named buckets", async () => {
    const day = new Date("2026-06-01T10:00:00.000Z");
    const rows = [
      { userId: "u1", action: "auth.login", createdAt: day },
      { userId: "u1", action: "alert.create", createdAt: day },
      { userId: "u1", action: "feedback.create", createdAt: day },
    ];
    const { ctx } = statsCtx(rows, [{ id: "u1" }]);
    const result = await activityStats(null, {}, ctx);

    expect(result.totals).toMatchObject({
      login: 1,
      alertCreate: 1,
      feedbackCreate: 1,
      total: 3,
    });
  });

  it("counts an unknown action toward total only (no named bucket)", async () => {
    const day = new Date("2026-06-01T10:00:00.000Z");
    const rows = [
      { userId: "u1", action: "auth.login", createdAt: day },
      { userId: "u1", action: "mystery.action", createdAt: day },
    ];
    const { ctx } = statsCtx(rows, [{ id: "u1" }]);
    const result = await activityStats(null, {}, ctx);

    expect(result.totals.login).toBe(1);
    expect(result.totals.total).toBe(2);
    // No named bucket was bumped for the unknown action.
    const namedSum =
      result.totals.login +
      result.totals.signalCreateManual +
      result.totals.eventCreate +
      result.totals.alertCreate +
      result.totals.crisisCreate +
      result.totals.feedbackCreate;
    expect(namedSum).toBe(1);
  });

  it("orders byUser descending by total and looks up exactly those ids", async () => {
    const day = new Date("2026-06-01T10:00:00.000Z");
    const rows = [
      // u-low: 1 event, u-high: 3 events.
      { userId: "u-low", action: "event.create", createdAt: day },
      { userId: "u-high", action: "event.create", createdAt: day },
      { userId: "u-high", action: "alert.create", createdAt: day },
      { userId: "u-high", action: "auth.login", createdAt: day },
    ];
    const { ctx, userFindMany } = statsCtx(rows, [
      { id: "u-low" },
      { id: "u-high" },
    ]);
    const result = await activityStats(null, {}, ctx);

    // Lookup uses the top-N id set.
    const idFilter = userFindMany.mock.calls[0][0].where.id.in;
    expect(idFilter.sort()).toEqual(["u-high", "u-low"]);
    // Highest total first.
    expect(result.byUser.map((b: { user: { id: string } }) => b.user.id)).toEqual([
      "u-high",
      "u-low",
    ]);
    expect(result.byUser[0].total).toBe(3);
  });

  it("drops byUser entries whose user row no longer exists", async () => {
    const day = new Date("2026-06-01T10:00:00.000Z");
    const rows = [
      { userId: "ghost", action: "event.create", createdAt: day },
      { userId: "u-alive", action: "event.create", createdAt: day },
    ];
    // Only u-alive comes back from the user lookup; "ghost" was deleted.
    const { ctx } = statsCtx(rows, [{ id: "u-alive" }]);
    const result = await activityStats(null, {}, ctx);

    expect(result.byUser.map((b: { user: { id: string } }) => b.user.id)).toEqual([
      "u-alive",
    ]);
  });

  it("orders byDay ascending by date with per-day counts", async () => {
    const rows = [
      { userId: "u1", action: "auth.login", createdAt: new Date("2026-06-03T08:00:00.000Z") },
      { userId: "u1", action: "auth.login", createdAt: new Date("2026-06-01T08:00:00.000Z") },
      { userId: "u1", action: "alert.create", createdAt: new Date("2026-06-01T09:00:00.000Z") },
    ];
    const { ctx } = statsCtx(rows, [{ id: "u1" }]);
    const result = await activityStats(null, {}, ctx);

    expect(result.byDay.map((d: { date: string }) => d.date)).toEqual([
      "2026-06-01",
      "2026-06-03",
    ]);
    expect(result.byDay[0].total).toBe(2); // two events on 06-01
    expect(result.byDay[1].total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// userEngagement — window bounds and ratio.
// ---------------------------------------------------------------------------

describe("Query.userEngagement", () => {
  function engagementCtx(counts: number[]) {
    // $queryRaw is called once per window (dau, wau, mau) in order.
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ count: BigInt(counts[0]) }])
      .mockResolvedValueOnce([{ count: BigInt(counts[1]) }])
      .mockResolvedValueOnce([{ count: BigInt(counts[2]) }]);
    return { ctx: buildContext(ADMIN, { $queryRaw: queryRaw }), queryRaw };
  }

  it("returns dau/wau/mau and dauMauRatio as a percentage", async () => {
    const { ctx } = engagementCtx([5, 20, 50]);
    const result = await userEngagement(
      null,
      { asOf: "2026-06-29T00:00:00.000Z" },
      ctx,
    );
    expect(result).toMatchObject({ dau: 5, wau: 20, mau: 50 });
    expect(result.dauMauRatio).toBeCloseTo((5 / 50) * 100);
    expect(result.asOf.toISOString()).toBe("2026-06-29T00:00:00.000Z");
  });

  it("clamps dauMauRatio to 0 when mau is 0 (no NaN)", async () => {
    const { ctx } = engagementCtx([0, 0, 0]);
    const result = await userEngagement(null, {}, ctx);
    expect(result.dauMauRatio).toBe(0);
    expect(Number.isNaN(result.dauMauRatio)).toBe(false);
  });

  it("uses trailing 1d / 7d / 30d windows ending at asOf", async () => {
    const { ctx, queryRaw } = engagementCtx([1, 1, 1]);
    const asOf = "2026-06-29T00:00:00.000Z";
    await userEngagement(null, { asOf }, ctx);

    const asOfMs = new Date(asOf).getTime();
    const DAY = 86_400_000;
    // $queryRaw is a tagged template: args[1..] are the interpolated values
    // (since, asOf) in order: LOGIN_ACTION, since, asOf.
    const [dauCall, wauCall, mauCall] = queryRaw.mock.calls;
    const sinceOf = (call: unknown[]) => (call[2] as Date).getTime();
    const asOfOf = (call: unknown[]) => (call[3] as Date).getTime();

    expect(asOfMs - sinceOf(dauCall)).toBe(DAY);
    expect(asOfMs - sinceOf(wauCall)).toBe(7 * DAY);
    expect(asOfMs - sinceOf(mauCall)).toBe(30 * DAY);
    expect(asOfOf(dauCall)).toBe(asOfMs);
    expect(asOfOf(mauCall)).toBe(asOfMs);
  });
});

// ---------------------------------------------------------------------------
// dauSeries / mauSeries — raw-row mapping.
// ---------------------------------------------------------------------------

describe("Query.dauSeries", () => {
  it("maps raw rows to { date: YYYY-MM-DD, uniqueUsers: number }", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { date: new Date("2026-06-01T00:00:00.000Z"), unique_users: BigInt(7) },
      { date: new Date("2026-06-02T00:00:00.000Z"), unique_users: BigInt(3) },
    ]);
    const ctx = buildContext(ADMIN, { $queryRaw: queryRaw });
    const result = await dauSeries(
      null,
      { from: "2026-06-01", to: "2026-06-30" },
      ctx,
    );
    expect(result).toEqual([
      { date: "2026-06-01", uniqueUsers: 7 },
      { date: "2026-06-02", uniqueUsers: 3 },
    ]);
    expect(typeof result[0].uniqueUsers).toBe("number");
  });

  it("passes from/to as Date objects to the raw query", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(ADMIN, { $queryRaw: queryRaw });
    await dauSeries(null, { from: "2026-06-01", to: "2026-06-30" }, ctx);
    const call = queryRaw.mock.calls[0];
    // tagged template values: LOGIN_ACTION, from, to
    expect(call[2]).toBeInstanceOf(Date);
    expect(call[3]).toBeInstanceOf(Date);
  });
});

describe("Query.mauSeries", () => {
  it("maps raw rows to { month: YYYY-MM, uniqueUsers: number }", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { month: new Date("2026-05-01T00:00:00.000Z"), unique_users: BigInt(40) },
      { month: new Date("2026-06-01T00:00:00.000Z"), unique_users: BigInt(55) },
    ]);
    const ctx = buildContext(ADMIN, { $queryRaw: queryRaw });
    const result = await mauSeries(
      null,
      { from: "2026-01-01", to: "2026-12-31" },
      ctx,
    );
    expect(result).toEqual([
      { month: "2026-05", uniqueUsers: 40 },
      { month: "2026-06", uniqueUsers: 55 },
    ]);
  });
});
