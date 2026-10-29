/**
 * Unit tests for the `language` validation in `updateProfile`.
 *
 * These are DB-free: `prisma.user.update` is mocked, so the test exercises the
 * validation/normalization branch without touching a database. Invalid input
 * throws before any DB call; valid input is lowercased before persistence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

const { logActivityMock } = vi.hoisted(() => ({
  logActivityMock: vi.fn(async () => undefined),
}));

vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: logActivityMock,
}));

import { userResolvers } from "../../src/resolvers/user.resolver.js";
import type { Context } from "../../src/context.js";

type UpdateFn = (args: { where: unknown; data: Record<string, unknown> }) => Promise<unknown>;

function buildContext(update: UpdateFn): Context {
  return {
    prisma: { user: { update, findUnique: vi.fn() } },
    user: { id: "u1", role: "member", isActive: true },
    session: null,
    authMethod: "session",
  } as unknown as Context;
}

const updateProfile = userResolvers.Mutation.updateProfile;
const updateUserRole = userResolvers.Mutation.updateUserRole;

beforeEach(() => {
  logActivityMock.mockClear();
});

describe("updateProfile — language validation", () => {
  it("normalizes a valid BCP-47 tag to lowercase", async () => {
    const update = vi.fn(async (args) => ({ id: "u1", ...args.data }));
    await updateProfile(undefined, { input: { language: "en-US" } }, buildContext(update));
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { language: "en-us" } });
  });

  it("trims and lowercases a bare two-letter code", async () => {
    const update = vi.fn(async (args) => ({ id: "u1", ...args.data }));
    await updateProfile(undefined, { input: { language: "  AR " } }, buildContext(update));
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { language: "ar" } });
  });

  it("rejects a non-language string without touching the DB", async () => {
    const update = vi.fn();
    await expect(
      updateProfile(undefined, { input: { language: "english" } }, buildContext(update)),
    ).rejects.toThrow(GraphQLError);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an over-long value even when the subtags are individually valid", async () => {
    const update = vi.fn();
    // Each "-abcdefgh" subtag matches the regex; only the length cap rejects this.
    const longTag = "en" + "-abcdefgh".repeat(5); // 47 chars
    await expect(
      updateProfile(undefined, { input: { language: longTag } }, buildContext(update)),
    ).rejects.toThrow(/BCP-47/);
    expect(update).not.toHaveBeenCalled();
  });
});

function adminContext(prisma: Record<string, unknown>, user = { id: "admin-1", role: "admin", isActive: true }): Context {
  return {
    prisma,
    user,
    session: null,
    authMethod: "session",
  } as unknown as Context;
}

describe("updateUserRole — admin gate", () => {
  it("rejects a non-admin without touching the DB", async () => {
    const findUnique = vi.fn();
    await expect(
      updateUserRole(
        undefined,
        { userId: "u1", role: "admin" },
        adminContext({ user: { findUnique } }, { id: "u1", role: "member", isActive: true }),
      ),
    ).rejects.toThrow(/Insufficient permissions/);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    await expect(
      updateUserRole(
        undefined,
        { userId: "u1", role: "analyst" },
        adminContext({ user: { findUnique: vi.fn() } }, null as never),
      ),
    ).rejects.toThrow(/logged in/i);
  });

  it("lets an admin persist the new role", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: "u1",
      email: "ok@example.com",
      role: "member",
    });
    const update = vi.fn().mockResolvedValue({
      id: "u1",
      email: "ok@example.com",
      role: "admin",
    });
    const result = await updateUserRole(
      undefined,
      { userId: "u1", role: "admin" },
      adminContext({ user: { findUnique, update, count: vi.fn() } }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { role: "admin" },
    });
    expect(result).toMatchObject({ id: "u1", role: "admin" });
  });
});

describe("analyticsOptOut", () => {
  it("updateProfile persists the opt-out", async () => {
    const update = vi.fn(async (args) => ({ id: "u1", ...args.data }));
    await updateProfile(undefined, { input: { analyticsOptOut: true } }, buildContext(update));
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { analyticsOptOut: true } });
  });

  it("updateProfile can opt back in", async () => {
    const update = vi.fn(async (args) => ({ id: "u1", ...args.data }));
    await updateProfile(undefined, { input: { analyticsOptOut: false } }, buildContext(update));
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { analyticsOptOut: false } });
  });

  it("updateProfile treats an explicit null as no change", async () => {
    const update = vi.fn(async (args) => ({ id: "u1", ...args.data }));
    await updateProfile(undefined, { input: { analyticsOptOut: null } }, buildContext(update));
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: {} });
  });

  const field = userResolvers.User.analyticsOptOut;
  const ctx = (user: unknown, stored: boolean | undefined = true) => {
    const findUnique = vi.fn(async () => (stored === undefined ? null : { analyticsOptOut: stored }));
    return { context: { user, prisma: { user: { findUnique } } } as unknown as Context, findUnique };
  };

  it("is read fresh from the database for the user themselves", async () => {
    // The parent (a cached session user) says false; the saved row says true.
    const { context, findUnique } = ctx({ id: "u1", role: "member" }, true);
    await expect(field({ id: "u1", analyticsOptOut: false } as { id: string }, {}, context)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { analyticsOptOut: true } });
    await expect(field({ id: "u1" }, {}, ctx({ id: "u1", role: "member" }, false).context)).resolves.toBe(false);
  });

  it("is null for other users, admins included, and anonymous callers", async () => {
    for (const user of [{ id: "u2", role: "member" }, { id: "admin-1", role: "admin" }, null]) {
      const { context, findUnique } = ctx(user);
      await expect(field({ id: "u1" }, {}, context)).resolves.toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    }
  });
});
