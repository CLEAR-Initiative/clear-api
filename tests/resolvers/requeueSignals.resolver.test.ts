/**
 * Unit tests (mocked Prisma) for requeueSignals — the admin backfill lever that
 * puts drained signals back to NEW so the Dagster drain re-classifies and
 * re-groups them (e.g. after a location fix for a push feed).
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";

function ctx(prisma: unknown, role: string | null = "admin"): Context {
  return {
    prisma,
    user: role ? ({ id: "u1", role } as unknown) : null,
    session: null,
    authMethod: role ? "session" : null,
    locale: "en",
  } as Context;
}

const requeue = signalResolvers.Mutation.requeueSignals;

describe("requeueSignals", () => {
  it("sets NEW, clears processedAt, and skips signals still linked to an event", async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const count = await requeue({}, { ids: ["s1", "s2", "s3"] }, ctx({ signals: { updateMany } }));

    expect(count).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["s1", "s2", "s3"] }, signalEvents: { none: {} } },
      data: { status: "NEW", processedAt: null },
    });
  });

  it("returns 0 for an empty list without touching the DB", async () => {
    const updateMany = vi.fn();
    expect(await requeue({}, { ids: [] }, ctx({ signals: { updateMany } }))).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects more than 500 ids", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `s${i}`);
    await expect(
      requeue({}, { ids }, ctx({ signals: { updateMany: vi.fn() } })),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("is admin only — pipeline, member and anonymous are rejected", async () => {
    for (const role of ["pipeline", "member", null]) {
      await expect(
        requeue({}, { ids: ["s1"] }, ctx({ signals: { updateMany: vi.fn() } }, role)),
      ).rejects.toBeInstanceOf(GraphQLError);
    }
  });
});
