/**
 * Unit tests for `resolveRequestAuth` in `src/utils/request-auth.ts` — the
 * single source of truth that turns request headers into a `ResolvedAuth`
 * ({ user, session, authMethod }), shared by the GraphQL context and the REST
 * upload route.
 *
 * DB-free: Better Auth (`auth.api.getSession`) and the prisma `apiKeys`
 * delegate are both stubbed with `vi.fn()`, so the auth-resolution branches are
 * exercised without a database. The real `hashKey` (pure SHA-256) is allowed to
 * run. These always run, including in CI.
 *
 * Branches covered:
 *  - valid cookie session            → user + authMethod "session"
 *  - no credentials                  → null / unauthenticated
 *  - getSession throws               → falls through (not fatal)
 *  - valid Bearer sk_live_ API key   → user + authMethod "api-key", lastUsedAt touched
 *  - revoked key                     → unauthenticated
 *  - expired key                     → unauthenticated
 *  - not-yet-expired key             → authenticated
 *  - null/no expiry                  → authenticated
 *  - unknown key (no row)            → unauthenticated
 *  - prisma lookup throws            → unauthenticated (swallowed)
 *  - non-sk_live_ / non-Bearer / array authorization header → API-key path skipped
 *  - precedence: session wins, API-key lookup never runs
 *  - active-account gate: isActive === false → null on both paths
 *  - lastUsedAt update rejection is swallowed (fire-and-forget)
 *
 * Skipped (trivial, no logic): `hashKey`/`generateApiKey` in api-key.ts are
 * tested implicitly and have no branching worth a dedicated unit test here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingHttpHeaders } from "node:http";

// Hoisted so the vi.mock factories can close over them.
const { getSessionMock, findUniqueMock, updateMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../../src/lib/auth.js", () => ({
  auth: { api: { getSession: getSessionMock } },
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    apiKeys: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
}));

import { resolveRequestAuth } from "../../src/utils/request-auth.js";
import { generateApiKey, hashKey } from "../../src/utils/api-key.js";

/** A Better Auth session result shape (user + session). */
function sessionResult(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: "u-session", role: "admin", isActive: true },
    session: { id: "sess-1", userId: "u-session" },
    ...overrides,
  };
}

/** Build an apiKeys row as returned by `findUnique({ include: { user: true } })`. */
function apiKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    keyHash: "irrelevant — matched by mock",
    revokedAt: null,
    expiresAt: null,
    user: { id: "u-apikey", role: "pipeline", isActive: true },
    ...overrides,
  };
}

beforeEach(() => {
  getSessionMock.mockReset();
  findUniqueMock.mockReset();
  updateMock.mockReset();
  // Defaults: no session, no key row, update resolves.
  getSessionMock.mockResolvedValue(null);
  findUniqueMock.mockResolvedValue(null);
  updateMock.mockResolvedValue({});
});

describe("resolveRequestAuth — no credentials", () => {
  it("returns a fully-null result when there are no headers at all", async () => {
    const result = await resolveRequestAuth({} as IncomingHttpHeaders);
    expect(result).toEqual({ user: null, session: null, authMethod: null });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("resolveRequestAuth — cookie session", () => {
  it("returns the user + session with authMethod 'session' for a valid cookie", async () => {
    const sess = sessionResult();
    getSessionMock.mockResolvedValue(sess);

    const result = await resolveRequestAuth({
      cookie: "better-auth.session_token=abc",
    } as IncomingHttpHeaders);

    expect(result.user).toBe(sess.user);
    expect(result.session).toBe(sess.session);
    expect(result.authMethod).toBe("session");
    // Session won — the API-key lookup must not run.
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("passes the request headers through to getSession", async () => {
    getSessionMock.mockResolvedValue(sessionResult());
    await resolveRequestAuth({ cookie: "x=y" } as IncomingHttpHeaders);
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    // fromNodeHeaders turns the plain object into a Headers instance.
    const arg = getSessionMock.mock.calls[0][0] as { headers: Headers };
    expect(arg.headers.get("cookie")).toBe("x=y");
  });

  it("falls through to the API-key path when getSession throws", async () => {
    getSessionMock.mockRejectedValue(new Error("auth backend down"));
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockResolvedValue(apiKeyRow());

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result.authMethod).toBe("api-key");
    expect(result.user).toEqual({ id: "u-apikey", role: "pipeline", isActive: true });
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveRequestAuth — API key (Bearer sk_live_)", () => {
  it("authenticates a valid key, returns authMethod 'api-key' and the key's user", async () => {
    const { plaintextKey } = generateApiKey();
    const row = apiKeyRow();
    findUniqueMock.mockResolvedValue(row);

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result.authMethod).toBe("api-key");
    expect(result.user).toBe(row.user);
    expect(result.session).toBeNull();
  });

  it("looks the key up by the SHA-256 hash of the plaintext (not the plaintext)", async () => {
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockResolvedValue(apiKeyRow());

    await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { keyHash: hashKey(plaintextKey) },
      include: { user: true },
    });
    // Defensive: the plaintext must never be the lookup value.
    expect(findUniqueMock.mock.calls[0][0].where.keyHash).not.toBe(plaintextKey);
  });

  it("touches lastUsedAt (fire-and-forget) on a successful key auth", async () => {
    const { plaintextKey } = generateApiKey();
    const row = apiKeyRow({ id: 99 });
    findUniqueMock.mockResolvedValue(row);

    await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: number };
      data: { lastUsedAt: Date };
    };
    expect(arg.where).toEqual({ id: 99 });
    expect(arg.data.lastUsedAt).toBeInstanceOf(Date);
  });

  it("does not reject when the lastUsedAt update fails (fire-and-forget swallowed)", async () => {
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockResolvedValue(apiKeyRow());
    updateMock.mockRejectedValue(new Error("write conflict"));

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    // Auth still succeeds even though the side-effect write rejected.
    expect(result.authMethod).toBe("api-key");
  });

  it("rejects a revoked key as unauthenticated", async () => {
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockResolvedValue(apiKeyRow({ revokedAt: new Date("2020-01-01") }));

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result).toEqual({ user: null, session: null, authMethod: null });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects an expired key as unauthenticated", async () => {
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockResolvedValue(
      apiKeyRow({ expiresAt: new Date(Date.now() - 60_000) }),
    );

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result.authMethod).toBeNull();
    expect(result.user).toBeNull();
  });

  it("accepts a key whose expiry is in the future", async () => {
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockResolvedValue(
      apiKeyRow({ expiresAt: new Date(Date.now() + 60_000) }),
    );

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result.authMethod).toBe("api-key");
  });

  it("accepts a key with no expiry (expiresAt null)", async () => {
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockResolvedValue(apiKeyRow({ expiresAt: null }));

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result.authMethod).toBe("api-key");
  });

  it("returns unauthenticated for an unknown key (no matching row)", async () => {
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockResolvedValue(null);

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result).toEqual({ user: null, session: null, authMethod: null });
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns unauthenticated when the prisma lookup throws (error swallowed)", async () => {
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockRejectedValue(new Error("db unreachable"));

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result).toEqual({ user: null, session: null, authMethod: null });
  });
});

describe("resolveRequestAuth — non-matching authorization headers", () => {
  it("ignores a Bearer token that is not an sk_live_ key", async () => {
    const result = await resolveRequestAuth({
      authorization: "Bearer some-jwt-or-other-token",
    } as IncomingHttpHeaders);

    expect(result.authMethod).toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("ignores a raw sk_live_ key without the Bearer prefix", async () => {
    const { plaintextKey } = generateApiKey();
    const result = await resolveRequestAuth({
      authorization: plaintextKey, // no "Bearer " prefix
    } as IncomingHttpHeaders);

    expect(result.authMethod).toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("ignores an array-valued authorization header (not a string)", async () => {
    const result = await resolveRequestAuth({
      authorization: ["Bearer sk_live_a", "Bearer sk_live_b"],
    } as unknown as IncomingHttpHeaders);

    expect(result.authMethod).toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("resolveRequestAuth — session/API-key precedence", () => {
  it("prefers the session and never runs the API-key lookup when both are present", async () => {
    const sess = sessionResult();
    getSessionMock.mockResolvedValue(sess);
    const { plaintextKey } = generateApiKey();

    const result = await resolveRequestAuth({
      cookie: "better-auth.session_token=abc",
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result.authMethod).toBe("session");
    expect(result.user).toBe(sess.user);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("resolveRequestAuth — active-account gate", () => {
  it("returns null for an inactive user authenticated via session", async () => {
    getSessionMock.mockResolvedValue(
      sessionResult({ user: { id: "u-session", role: "admin", isActive: false } }),
    );

    const result = await resolveRequestAuth({
      cookie: "better-auth.session_token=abc",
    } as IncomingHttpHeaders);

    expect(result).toEqual({ user: null, session: null, authMethod: null });
  });

  it("returns null for an inactive user authenticated via API key", async () => {
    const { plaintextKey } = generateApiKey();
    findUniqueMock.mockResolvedValue(
      apiKeyRow({ user: { id: "u-apikey", role: "pipeline", isActive: false } }),
    );

    const result = await resolveRequestAuth({
      authorization: `Bearer ${plaintextKey}`,
    } as IncomingHttpHeaders);

    expect(result).toEqual({ user: null, session: null, authMethod: null });
  });

  it("does not gate a user whose isActive is undefined (only an explicit false)", async () => {
    getSessionMock.mockResolvedValue(
      sessionResult({ user: { id: "u-session", role: "admin" } }), // no isActive
    );

    const result = await resolveRequestAuth({
      cookie: "better-auth.session_token=abc",
    } as IncomingHttpHeaders);

    expect(result.authMethod).toBe("session");
    expect(result.user).toEqual({ id: "u-session", role: "admin" });
  });
});
