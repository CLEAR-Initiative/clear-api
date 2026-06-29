/**
 * Unit tests for the auth guards in `src/utils/auth-guard.ts` — the helpers
 * every resolver leans on for access control.
 *
 * DB-free: `prisma` is stubbed per-test, so these exercise the guard logic
 * (auth/role checks, the org-share visibility rule, the per-request PII cache)
 * without touching a database. They always run, including in CI.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import {
  requireAuth,
  requireRole,
  resolveTeamMembership,
  canSeeUserPii,
  canSeeUserPrivate,
} from "../../src/utils/auth-guard.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string | null; isActive?: boolean };

/**
 * Builds a Context. `prisma` accepts a partial override so each test only
 * stubs the delegate it actually uses.
 */
function buildContext(
  user: User | null,
  prisma: Record<string, unknown> = {},
): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

/** Extract the `code` from a thrown GraphQLError for assertions. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof GraphQLError) return String(e.extensions?.code);
    throw e;
  }
  throw new Error("expected the function to throw");
}

describe("requireAuth", () => {
  it("returns the user when authenticated", () => {
    const user = { id: "u1", role: "viewer" };
    expect(requireAuth(buildContext(user))).toBe(user);
  });

  it("throws UNAUTHENTICATED when there is no user", () => {
    expect(codeOf(() => requireAuth(buildContext(null)))).toBe("UNAUTHENTICATED");
  });
});

describe("requireRole", () => {
  it("returns the user when their role is in the allow-list", () => {
    const user = { id: "u1", role: "admin" };
    expect(requireRole(buildContext(user), ["admin", "analyst"])).toBe(user);
  });

  it("throws FORBIDDEN when the role is not allowed", () => {
    const ctx = buildContext({ id: "u1", role: "viewer" });
    expect(codeOf(() => requireRole(ctx, ["admin"]))).toBe("FORBIDDEN");
  });

  it("throws FORBIDDEN when the user has no role at all", () => {
    const ctx = buildContext({ id: "u1", role: null });
    expect(codeOf(() => requireRole(ctx, ["admin"]))).toBe("FORBIDDEN");
  });

  it("throws UNAUTHENTICATED (not FORBIDDEN) when unauthenticated", () => {
    // requireRole delegates to requireAuth first, so the missing-user case
    // surfaces as UNAUTHENTICATED before any role comparison.
    expect(codeOf(() => requireRole(buildContext(null), ["admin"]))).toBe(
      "UNAUTHENTICATED",
    );
  });
});

describe("resolveTeamMembership", () => {
  it("returns null for a global admin without hitting the DB", async () => {
    const findUnique = vi.fn();
    const prisma = { teamMembers: { findUnique } };
    const result = await resolveTeamMembership(
      prisma as never,
      "u1",
      "t1",
      "admin",
    );
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns the membership row when the user is a member", async () => {
    const membership = { teamId: "t1", userId: "u1", role: "lead" };
    const findUnique = vi.fn().mockResolvedValue(membership);
    const prisma = { teamMembers: { findUnique } };
    const result = await resolveTeamMembership(prisma as never, "u1", "t1", "viewer");
    expect(result).toBe(membership);
    expect(findUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: "t1", userId: "u1" } },
    });
  });

  it("throws FORBIDDEN when the user is not a team member", async () => {
    const prisma = { teamMembers: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(
      resolveTeamMembership(prisma as never, "u1", "t1", "viewer"),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
});

describe("canSeeUserPii", () => {
  it("returns false for an unauthenticated caller", async () => {
    expect(await canSeeUserPii(buildContext(null), "target")).toBe(false);
  });

  it("returns true for self", async () => {
    const ctx = buildContext({ id: "me", role: "viewer" });
    expect(await canSeeUserPii(ctx, "me")).toBe(true);
  });

  it("returns true for a global admin", async () => {
    const ctx = buildContext({ id: "admin1", role: "admin" });
    expect(await canSeeUserPii(ctx, "someone-else")).toBe(true);
  });

  it("returns true when caller and target share an organisation", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "ou1" });
    const ctx = buildContext({ id: "me", role: "viewer" }, {
      organisationUsers: { findFirst },
    });
    expect(await canSeeUserPii(ctx, "colleague")).toBe(true);
  });

  it("returns false when caller and target share no organisation", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const ctx = buildContext({ id: "me", role: "viewer" }, {
      organisationUsers: { findFirst },
    });
    expect(await canSeeUserPii(ctx, "stranger")).toBe(false);
  });

  it("caches the result per request — a second call does not re-query", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "ou1" });
    const ctx = buildContext({ id: "me", role: "viewer" }, {
      organisationUsers: { findFirst },
    });
    expect(await canSeeUserPii(ctx, "colleague")).toBe(true);
    expect(await canSeeUserPii(ctx, "colleague")).toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("canSeeUserPrivate", () => {
  it("returns false for an unauthenticated caller", () => {
    expect(canSeeUserPrivate(buildContext(null), "target")).toBe(false);
  });

  it("returns true for self", () => {
    expect(canSeeUserPrivate(buildContext({ id: "me", role: "viewer" }), "me")).toBe(
      true,
    );
  });

  it("returns true for a global admin", () => {
    expect(
      canSeeUserPrivate(buildContext({ id: "a", role: "admin" }), "other"),
    ).toBe(true);
  });

  it("returns false when merely sharing an org (stricter than PII)", () => {
    // Unlike canSeeUserPii, an org-mate is NOT granted private-relation access;
    // this guard is synchronous and never consults the DB.
    expect(
      canSeeUserPrivate(buildContext({ id: "me", role: "viewer" }), "colleague"),
    ).toBe(false);
  });
});
