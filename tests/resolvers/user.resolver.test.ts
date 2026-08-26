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
    user: { id: "u1", role: "viewer", isActive: true },
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
        { userId: "u1", role: "analyst" },
        adminContext({ user: { findUnique } }, { id: "u1", role: "viewer", isActive: true }),
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
      role: "viewer",
    });
    const update = vi.fn().mockResolvedValue({
      id: "u1",
      email: "ok@example.com",
      role: "analyst",
    });
    const result = await updateUserRole(
      undefined,
      { userId: "u1", role: "analyst" },
      adminContext({ user: { findUnique, update, count: vi.fn() } }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { role: "analyst" },
    });
    expect(result).toMatchObject({ id: "u1", role: "analyst" });
  });
});
