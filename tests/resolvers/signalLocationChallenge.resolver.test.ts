/**
 * Unit tests for `signalLocationChallenge.resolver.ts` — DB-free.
 *
 * `context.prisma.*` is stubbed with `vi.fn()` delegates; these cover the
 * auth gate, input validation (point pair + ranges + trimming), the upsert
 * shape (createdBy, open-status key, geometry never touched), the team-scope
 * defaulting on the list query, and the two field resolvers.
 */

import { describe, it, expect, vi } from "vitest";
import { signalLocationChallengeResolvers } from "../../src/resolvers/signalLocationChallenge.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
    locale: "en",
  } as Context;
}

const ANALYST = { id: "u-analyst", role: "analyst" };
const PENDING = { id: "u-pending", role: "pending" };

const { signalLocationChallenges } = signalLocationChallengeResolvers.Query;
const { submitSignalLocationChallenge } = signalLocationChallengeResolvers.Mutation;
const { locationChallenge } = signalLocationChallengeResolvers.Signal;
const { hasProposedPoint } = signalLocationChallengeResolvers.SignalLocationChallenge;

describe("Query.signalLocationChallenges", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      signalLocationChallenges(null, {}, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("defaults status to consideration and applies no signal filter without teamId", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(ANALYST, { signalLocationChallenges: { findMany } });
    await signalLocationChallenges(null, {}, ctx);
    expect(findMany.mock.calls[0][0].where).toEqual({ status: "consideration" });
  });

  it("applies no signal filter for a team with no locations (global monitoring)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    // buildLocationFilterForTeam returns undefined when the team has no scope
    // locations → the query is unfiltered beyond status.
    const ctx = buildContext(ANALYST, {
      signalLocationChallenges: { findMany },
      teamLocations: { findMany: vi.fn().mockResolvedValue([]) },
    });
    await signalLocationChallenges(null, { teamId: "T1", status: "consideration" }, ctx);
    const where = findMany.mock.calls[0][0].where;
    expect(where).toEqual({ status: "consideration" });
    expect(where.signal).toBeUndefined();
  });
});

describe("Mutation.submitSignalLocationChallenge", () => {
  const base = { signalId: "S1" };

  it("throws UNAUTHENTICATED when not logged in (no signal lookup)", async () => {
    const findUnique = vi.fn();
    await expect(
      submitSignalLocationChallenge(null, { input: base }, buildContext(null, { signals: { findUnique } })),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN for a pending (unapproved) account", async () => {
    const findUnique = vi.fn();
    await expect(
      submitSignalLocationChallenge(null, { input: base }, buildContext(PENDING, { signals: { findUnique } })),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the signal does not exist", async () => {
    const ctx = buildContext(ANALYST, { signals: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      submitSignalLocationChallenge(null, { input: base }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("rejects a half point (lng without lat)", async () => {
    const ctx = buildContext(ANALYST, { signals: { findUnique: vi.fn().mockResolvedValue({ id: "S1" }) } });
    await expect(
      submitSignalLocationChallenge(null, { input: { ...base, proposedLng: 30 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects an out-of-range latitude", async () => {
    const ctx = buildContext(ANALYST, { signals: { findUnique: vi.fn().mockResolvedValue({ id: "S1" }) } });
    await expect(
      submitSignalLocationChallenge(null, { input: { ...base, proposedLng: 30, proposedLat: 999 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("upserts a bare challenge with createdBy and the open-status key, no geometry write", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "C1" });
    const signalsUpdate = vi.fn();
    const ctx = buildContext(ANALYST, {
      signals: { findUnique: vi.fn().mockResolvedValue({ id: "S1" }), update: signalsUpdate },
      signalLocationChallenges: { upsert },
    });
    const result = await submitSignalLocationChallenge(null, { input: { signalId: "S1", note: "  looks off  " } }, ctx);
    expect(result).toEqual({ id: "C1" });
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ signalId_status: { signalId: "S1", status: "consideration" } });
    expect(arg.create).toMatchObject({
      signalId: "S1", status: "consideration", createdBy: "u-analyst",
      note: "looks off", proposedLng: null, proposedLat: null, proposedName: null,
    });
    expect(signalsUpdate).not.toHaveBeenCalled(); // never touches signal geometry
  });

  it("upserts a correction with a valid point", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "C2" });
    const ctx = buildContext(ANALYST, {
      signals: { findUnique: vi.fn().mockResolvedValue({ id: "S1" }) },
      signalLocationChallenges: { upsert },
    });
    await submitSignalLocationChallenge(
      null, { input: { signalId: "S1", proposedLng: 30.5, proposedLat: 15.2, proposedName: "Nyala" } }, ctx,
    );
    expect(upsert.mock.calls[0][0].create).toMatchObject({ proposedLng: 30.5, proposedLat: 15.2, proposedName: "Nyala" });
  });
});

describe("Signal.locationChallenge field resolver", () => {
  it("returns the preloaded value when present (fast path)", async () => {
    const findFirst = vi.fn();
    const preloaded = { id: "C1" };
    const out = await locationChallenge(
      { id: "S1", locationChallenge: preloaded }, {}, buildContext(ANALYST, { signalLocationChallenges: { findFirst } }),
    );
    expect(out).toBe(preloaded);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("loads the open row when not preloaded", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "C1" });
    await locationChallenge({ id: "S1" }, {}, buildContext(ANALYST, { signalLocationChallenges: { findFirst } }));
    expect(findFirst.mock.calls[0][0].where).toEqual({ signalId: "S1", status: "consideration" });
  });
});

describe("SignalLocationChallenge.hasProposedPoint", () => {
  it("is true only when both coordinates are set", () => {
    expect(hasProposedPoint({ proposedLng: 30, proposedLat: 15 })).toBe(true);
    expect(hasProposedPoint({ proposedLng: 30, proposedLat: null })).toBe(false);
    expect(hasProposedPoint({ proposedLng: null, proposedLat: null })).toBe(false);
  });
});
