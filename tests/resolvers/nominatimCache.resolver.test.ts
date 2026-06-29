/**
 * Unit tests for `nominatimCache.resolver.ts`.
 *
 * DB-free: `context.prisma.nominatim_cache` is stubbed per-test with `vi.fn()`
 * delegates. Covers:
 *   - the admin-only role gate on both the query and the mutation,
 *   - the read-time expiry filter (expiresAt > now),
 *   - status whitelist validation on upsert,
 *   - positive-ttlSeconds validation,
 *   - the upsert data shape + TTL → expiresAt computation.
 *
 * The actual persistence (upsert round-trip) is delegated to prisma and not
 * re-tested here; we assert it's called with the right args.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { nominatimCacheResolvers } from "../../src/resolvers/nominatimCache.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(
  user: User,
  nominatim_cache: Record<string, unknown> = {},
): Context {
  return {
    prisma: { nominatim_cache } as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const ADMIN = { id: "a1", role: "admin" };

const { nominatimCacheEntry } = nominatimCacheResolvers.Query;
const { upsertNominatimCache } = nominatimCacheResolvers.Mutation;

const validInput = () => ({
  queryHash: "h1",
  query: "Cairo",
  endpoint: "/search",
  responseJson: { lat: 30, lon: 31 },
  status: "ok",
  ttlSeconds: 3600,
});

describe("Query.nominatimCacheEntry", () => {
  it("returns the matching, non-expired entry filtered by queryHash", async () => {
    const row = { id: 1, queryHash: "h1" };
    const findFirst = vi.fn().mockResolvedValue(row);
    const ctx = buildContext(ADMIN, { findFirst });

    const before = Date.now();
    const result = await nominatimCacheEntry(null, { queryHash: "h1" }, ctx);
    const after = Date.now();

    expect(result).toBe(row);
    const where = findFirst.mock.calls[0][0].where;
    expect(where.queryHash).toBe("h1");
    // Expired rows are filtered out at read time via expiresAt > now.
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    const cutoff = (where.expiresAt.gt as Date).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(after);
  });

  it("returns null on a cache miss (prisma returns null)", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(ADMIN, { findFirst });
    expect(await nominatimCacheEntry(null, { queryHash: "nope" }, ctx)).toBeNull();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    const findFirst = vi.fn();
    await expect(
      nominatimCacheEntry(null, { queryHash: "h1" }, buildContext(null, { findFirst })),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN for a non-admin caller", async () => {
    const findFirst = vi.fn();
    await expect(
      nominatimCacheEntry(
        null,
        { queryHash: "h1" },
        buildContext({ id: "u1", role: "viewer" }, { findFirst }),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("Mutation.upsertNominatimCache", () => {
  it("upserts by queryHash with computed expiresAt and shared update/create data", async () => {
    const created = { id: 1, queryHash: "h1" };
    const upsert = vi.fn().mockResolvedValue(created);
    const ctx = buildContext(ADMIN, { upsert });

    const before = Date.now();
    const result = await upsertNominatimCache(null, { input: validInput() }, ctx);
    const after = Date.now();

    expect(result).toBe(created);
    const call = upsert.mock.calls[0][0];
    expect(call.where).toEqual({ queryHash: "h1" });

    // update and create share the same content; create also pins queryHash.
    expect(call.update.query).toBe("Cairo");
    expect(call.update.endpoint).toBe("/search");
    expect(call.update.status).toBe("ok");
    expect(call.update.responseJson).toEqual({ lat: 30, lon: 31 });
    expect(call.create.queryHash).toBe("h1");
    expect(call.create.query).toBe("Cairo");

    // fetchedAt ~ now; expiresAt ~ now + ttlSeconds*1000.
    const fetchedAt = (call.update.fetchedAt as Date).getTime();
    const expiresAt = (call.update.expiresAt as Date).getTime();
    expect(fetchedAt).toBeGreaterThanOrEqual(before);
    expect(fetchedAt).toBeLessThanOrEqual(after);
    expect(expiresAt - fetchedAt).toBe(3600 * 1000);
  });

  it("accepts each allowed status (ok, no_result, error)", async () => {
    for (const status of ["ok", "no_result", "error"]) {
      const upsert = vi.fn().mockResolvedValue({ id: 1 });
      const ctx = buildContext(ADMIN, { upsert });
      await upsertNominatimCache(null, { input: { ...validInput(), status } }, ctx);
      expect(upsert.mock.calls[0][0].update.status).toBe(status);
    }
  });

  it("rejects an invalid status with BAD_USER_INPUT and does not upsert", async () => {
    const upsert = vi.fn();
    const ctx = buildContext(ADMIN, { upsert });
    await expect(
      upsertNominatimCache(null, { input: { ...validInput(), status: "pending" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects ttlSeconds <= 0 with BAD_USER_INPUT and does not upsert", async () => {
    for (const ttlSeconds of [0, -10]) {
      const upsert = vi.fn();
      const ctx = buildContext(ADMIN, { upsert });
      await expect(
        upsertNominatimCache(null, { input: { ...validInput(), ttlSeconds } }, ctx),
      ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
      expect(upsert).not.toHaveBeenCalled();
    }
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    const upsert = vi.fn();
    await expect(
      upsertNominatimCache(null, { input: validInput() }, buildContext(null, { upsert })),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN for a non-admin caller before any validation", async () => {
    const upsert = vi.fn();
    // status is invalid too, but the role gate fires first.
    await expect(
      upsertNominatimCache(
        null,
        { input: { ...validInput(), status: "bogus" } },
        buildContext({ id: "u1", role: "viewer" }, { upsert }),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(upsert).not.toHaveBeenCalled();
  });
});
