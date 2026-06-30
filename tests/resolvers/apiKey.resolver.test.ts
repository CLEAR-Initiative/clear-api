/**
 * Unit tests for `apiKey.resolver.ts`.
 *
 * DB-free: `context.prisma.apiKeys` is stubbed per-test. Covers the auth gate,
 * the 10-key limit on creation, and the ownership / state branches on revoke.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { apiKeyResolvers } from "../../src/resolvers/apiKey.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, apiKeys: Record<string, unknown> = {}): Context {
  return {
    prisma: { apiKeys } as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const { myApiKeys } = apiKeyResolvers.Query;
const { createApiKey, revokeApiKey } = apiKeyResolvers.Mutation;

describe("Query.myApiKeys", () => {
  it("returns the caller's keys, newest first", () => {
    const rows = [{ id: "k1" }];
    const findMany = vi.fn().mockReturnValue(rows);
    const ctx = buildContext({ id: "u1", role: "viewer" }, { findMany });
    expect(myApiKeys(null, {}, ctx)).toBe(rows);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: { createdAt: "desc" },
    });
  });

  it("throws UNAUTHENTICATED when not logged in", () => {
    expect(() => myApiKeys(null, {}, buildContext(null))).toThrow(GraphQLError);
  });
});

describe("Mutation.createApiKey", () => {
  it("creates a key and returns the plaintext once", async () => {
    const created = { id: "k1", name: "CI" };
    const count = vi.fn().mockResolvedValue(3);
    const create = vi.fn().mockResolvedValue(created);
    const ctx = buildContext({ id: "u1", role: "viewer" }, { count, create });

    const result = await createApiKey(null, { input: { name: "CI" } }, ctx);

    expect(result.apiKey).toBe(created);
    expect(result.key).toMatch(/^sk_live_/);
    // Persisted with the caller's id, the supplied name, and a prefix + hash.
    const data = create.mock.calls[0][0].data;
    expect(data.userId).toBe("u1");
    expect(data.name).toBe("CI");
    expect(data.prefix).toMatch(/^sk_live_/);
    expect(typeof data.keyHash).toBe("string");
    expect(data.expiresAt).toBeNull();
  });

  it("passes expiresAt through as a Date when provided", async () => {
    const create = vi.fn().mockResolvedValue({ id: "k1" });
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      count: vi.fn().mockResolvedValue(0),
      create,
    });
    await createApiKey(
      null,
      { input: { name: "x", expiresAt: "2030-01-01T00:00:00.000Z" } },
      ctx,
    );
    const { expiresAt } = create.mock.calls[0][0].data;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("rejects with BAD_USER_INPUT when the caller already has 10 active keys", async () => {
    const create = vi.fn();
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      count: vi.fn().mockResolvedValue(10),
      create,
    });
    await expect(
      createApiKey(null, { input: { name: "x" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      createApiKey(null, { input: { name: "x" } }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.revokeApiKey", () => {
  it("revokes the caller's own key by stamping revokedAt", async () => {
    const update = vi.fn().mockResolvedValue({ id: "k1", revokedAt: new Date() });
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      findUnique: vi.fn().mockResolvedValue({ id: "k1", userId: "u1", revokedAt: null }),
      update,
    });
    await revokeApiKey(null, { id: "k1" }, ctx);
    expect(update.mock.calls[0][0].where).toEqual({ id: "k1" });
    expect(update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);
  });

  it("lets a global admin revoke another user's key", async () => {
    const update = vi.fn().mockResolvedValue({ id: "k1" });
    const ctx = buildContext({ id: "admin1", role: "admin" }, {
      findUnique: vi.fn().mockResolvedValue({ id: "k1", userId: "someone", revokedAt: null }),
      update,
    });
    await revokeApiKey(null, { id: "k1" }, ctx);
    expect(update).toHaveBeenCalledOnce();
  });

  it("throws NOT_FOUND when the key does not exist", async () => {
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      findUnique: vi.fn().mockResolvedValue(null),
    });
    await expect(revokeApiKey(null, { id: "missing" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("throws FORBIDDEN when a non-admin tries to revoke someone else's key", async () => {
    const update = vi.fn();
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      findUnique: vi.fn().mockResolvedValue({ id: "k1", userId: "other", revokedAt: null }),
      update,
    });
    await expect(revokeApiKey(null, { id: "k1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("throws BAD_USER_INPUT when the key is already revoked", async () => {
    const update = vi.fn();
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: "k1", userId: "u1", revokedAt: new Date() }),
      update,
    });
    await expect(revokeApiKey(null, { id: "k1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(revokeApiKey(null, { id: "k1" }, buildContext(null))).rejects.toThrow(
      GraphQLError,
    );
  });
});
