/**
 * Unit tests for the `language` validation in `updateProfile`.
 *
 * These are DB-free: `prisma.user.update` is mocked, so the test exercises the
 * validation/normalization branch without touching a database. Invalid input
 * throws before any DB call; valid input is lowercased before persistence.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
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
