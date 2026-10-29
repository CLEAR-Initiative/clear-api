/**
 * Unit tests for `signalLocationChallenge.resolver.ts`, DB-free.
 *
 * `context.prisma.*` is stubbed with `vi.fn()` delegates and the PostGIS
 * helpers are mocked. They cover who files and who decides (a team analyst
 * files, the team's admin decides, even one they filed), the team-area and
 * coverage rules, superseding instead of rewriting, the write onto the Signal
 * under a lock, the list queries, and the field resolvers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/geo-resolve.js", () => ({
  resolveContainingAdminArea: vi.fn(),
  findOrCreateLandmarkL4: vi.fn(),
  createPointLocation: vi.fn(),
  getLocationIdsWithDescendants: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../src/utils/location-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/location-scope.js")>()),
  getTeamScopeLocationIds: vi.fn(),
}));
vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

import { Prisma } from "../../src/generated/prisma/client.js";
import { signalLocationChallengeResolvers } from "../../src/resolvers/signalLocationChallenge.resolver.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import {
  createPointLocation,
  findOrCreateLandmarkL4,
  resolveContainingAdminArea,
} from "../../src/utils/geo-resolve.js";
import { getTeamScopeLocationIds } from "../../src/utils/location-scope.js";
import { logActivity } from "../../src/utils/activity-log.js";
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

const ANALYST = { id: "u-analyst", role: "member" };
const OTHER_ANALYST = { id: "u-analyst-2", role: "member" };
const TEAM_ADMIN = { id: "u-admin", role: "member" };
const OTHER_TEAMS_ADMIN = { id: "u-admin-t2", role: "member" };
const MEMBER = { id: "u-member", role: "member" };
const PLATFORM = { id: "u-platform", role: "admin" };
const PENDING = { id: "u-pending", role: "pending" };

/** Team roles by `${teamId}:${userId}`. */
const ROLES: Record<string, string> = {
  "T1:u-analyst": "analyst",
  "T1:u-analyst-2": "analyst",
  "T1:u-admin": "team_admin",
  "T1:u-member": "team_member",
  "T2:u-admin-t2": "team_admin",
};

function teamMembersFindUnique() {
  return vi.fn(async (args: { where: { teamId_userId: { teamId: string; userId: string } } }) => {
    const { teamId, userId } = args.where.teamId_userId;
    const role = ROLES[`${teamId}:${userId}`];
    return role ? { role } : null;
  });
}

// Team T1's area: district D1 and the point P-in under it.
const T1_AREA = ["D1", "P-in"];
const SIGNAL = { id: "S1", originId: null, destinationId: null, locationId: "P-in" };
const IN_DISTRICT = { id: "D1", name: "Nyala", level: 2 };
const OTHER_DISTRICT = { id: "D2", name: "Kass", level: 2 };

const {
  signalLocationChallenges,
  signalLocationChallengesToDecide,
  locationPlacement,
} = signalLocationChallengeResolvers.Query;
const { submitSignalLocationChallenge, decideSignalLocationChallenge } =
  signalLocationChallengeResolvers.Mutation;
const { hasProposedPoint, proposedPlacement, team } =
  signalLocationChallengeResolvers.SignalLocationChallenge;
const { locationChallenge } = signalResolvers.Signal;

beforeEach(() => {
  vi.mocked(getTeamScopeLocationIds).mockReset().mockResolvedValue(T1_AREA);
  vi.mocked(resolveContainingAdminArea).mockReset().mockResolvedValue(IN_DISTRICT);
  vi.mocked(findOrCreateLandmarkL4).mockReset().mockResolvedValue({
    locationId: "P-new",
    reused: false,
    pointType: "landmark-geocoded",
    abortedReason: null,
  });
  vi.mocked(createPointLocation).mockReset().mockResolvedValue({ id: "P-plain", name: "Point", level: 4 });
  vi.mocked(logActivity).mockClear();
});

// ─── Filing ──────────────────────────────────────────────────────────────────

function submitCtx(
  user: User,
  over: { signal?: unknown; team?: unknown; createError?: unknown } = {},
) {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (over.createError) throw over.createError;
    return { id: "C-new", ...args.data };
  });
  const lock = vi.fn().mockResolvedValue([]);
  const tx = { $queryRaw: lock, signalLocationChallenges: { updateMany, create } };
  const signalsFindUnique = vi.fn().mockResolvedValue("signal" in over ? over.signal : SIGNAL);
  const prisma = {
    teamMembers: { findUnique: teamMembersFindUnique() },
    teams: { findUnique: vi.fn().mockResolvedValue("team" in over ? over.team : { id: "T1" }) },
    signals: { findUnique: signalsFindUnique },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { ctx: buildContext(user, prisma), lock, updateMany, create, signalsFindUnique };
}

const FILING = { signalId: "S1", teamId: "T1" };

describe("Mutation.submitSignalLocationChallenge", () => {
  it("throws UNAUTHENTICATED when not logged in, before any lookup", async () => {
    const { ctx, signalsFindUnique } = submitCtx(null);
    await expect(submitSignalLocationChallenge(null, { input: FILING }, ctx)).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
    expect(signalsFindUnique).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN for a pending (unapproved) account", async () => {
    const { ctx, signalsFindUnique } = submitCtx(PENDING);
    await expect(submitSignalLocationChallenge(null, { input: FILING }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(signalsFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["a team member", MEMBER],
    ["the team's admin", TEAM_ADMIN],
    ["an admin of another team", OTHER_TEAMS_ADMIN],
  ])("refuses %s: only the team's analysts file", async (_who, user) => {
    const { ctx, signalsFindUnique } = submitCtx(user);
    await expect(submitSignalLocationChallenge(null, { input: FILING }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(signalsFindUnique).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a platform admin filing for a team that doesn't exist", async () => {
    const { ctx } = submitCtx(PLATFORM, { team: null });
    await expect(submitSignalLocationChallenge(null, { input: FILING }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("rejects a half point (lng without lat)", async () => {
    const { ctx } = submitCtx(ANALYST);
    await expect(
      submitSignalLocationChallenge(null, { input: { ...FILING, proposedLng: 30 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects an out-of-range latitude", async () => {
    const { ctx } = submitCtx(ANALYST);
    await expect(
      submitSignalLocationChallenge(null, { input: { ...FILING, proposedLng: 30, proposedLat: 999 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("throws NOT_FOUND when the signal does not exist", async () => {
    const { ctx } = submitCtx(ANALYST, { signal: null });
    await expect(submitSignalLocationChallenge(null, { input: FILING }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("refuses a signal outside the team's area", async () => {
    const { ctx, create } = submitCtx(ANALYST, { signal: { ...SIGNAL, locationId: "P-out" } });
    await expect(submitSignalLocationChallenge(null, { input: FILING }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a point outside the areas CLEAR covers", async () => {
    vi.mocked(resolveContainingAdminArea).mockResolvedValue(null);
    const { ctx, create } = submitCtx(ANALYST);
    await expect(
      submitSignalLocationChallenge(null, { input: { ...FILING, proposedLat: 1, proposedLng: 2 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a point outside the team's area, unless a platform admin files it", async () => {
    vi.mocked(resolveContainingAdminArea).mockResolvedValue(OTHER_DISTRICT);
    const input = { ...FILING, proposedLat: 12.7, proposedLng: 24.3 };
    await expect(
      submitSignalLocationChallenge(null, { input }, submitCtx(ANALYST).ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(
      submitSignalLocationChallenge(null, { input }, submitCtx(PLATFORM).ctx),
    ).resolves.toMatchObject({ id: "C-new", createdBy: "u-platform" });
  });

  it("files a bare challenge for the team, superseding the signal's open one", async () => {
    const { ctx, updateMany, create } = submitCtx(ANALYST);
    const result = await submitSignalLocationChallenge(
      null, { input: { ...FILING, note: "  looks off  " } }, ctx,
    );
    expect(result).toMatchObject({ id: "C-new" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { signalId: "S1", status: "consideration" },
      data: { status: "superseded" },
    });
    expect(create.mock.calls[0]![0].data).toEqual({
      signalId: "S1",
      status: "consideration",
      teamId: "T1",
      createdBy: "u-analyst",
      note: "looks off",
      proposedLng: null,
      proposedLat: null,
      proposedName: null,
      previousLocationId: "P-in",
    });
    // A bare challenge has no point to place.
    expect(resolveContainingAdminArea).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "signal.location_challenge.file", resourceId: "S1" }),
    );
  });

  it("locks the signal before superseding, the order deciding uses, so the two can't deadlock", async () => {
    const { ctx, lock, updateMany } = submitCtx(ANALYST);
    await submitSignalLocationChallenge(null, { input: FILING }, ctx);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock.mock.invocationCallOrder[0]!).toBeLessThan(updateMany.mock.invocationCallOrder[0]!);
  });

  it("files a corrected point with its name", async () => {
    const { ctx, create } = submitCtx(ANALYST);
    await submitSignalLocationChallenge(
      null,
      { input: { ...FILING, proposedLng: 24.88, proposedLat: 12.05, proposedName: " Nyala market " } },
      ctx,
    );
    expect(create.mock.calls[0]![0].data).toMatchObject({
      proposedLng: 24.88,
      proposedLat: 12.05,
      proposedName: "Nyala market",
    });
  });

  it("turns a simultaneous filing on the same signal into CONFLICT", async () => {
    const clash = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    const { ctx } = submitCtx(ANALYST, { createError: clash });
    await expect(submitSignalLocationChallenge(null, { input: FILING }, ctx)).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
  });
});

// ─── Deciding ────────────────────────────────────────────────────────────────

const OPEN = {
  id: "C1",
  signalId: "S1",
  teamId: "T1",
  status: "consideration",
  createdBy: "u-analyst",
  note: null,
  proposedLat: 12.05,
  proposedLng: 24.88,
  proposedName: "Nyala market",
};

function decideCtx(
  user: User,
  challenge: unknown = OPEN,
  over: { signal?: unknown; locked?: unknown; count?: number; country?: unknown; pointAncestors?: string[] } = {},
) {
  const count = over.count ?? 1;
  const outsideUpdateMany = vi.fn().mockResolvedValue({ count });
  const txUpdateMany = vi.fn().mockResolvedValue({ count });
  const signalsUpdate = vi.fn().mockResolvedValue({});
  const lock = vi.fn().mockResolvedValue([]);
  const tx = {
    $queryRaw: lock,
    signals: {
      findUnique: vi.fn().mockResolvedValue(
        "locked" in over ? over.locked : { ...SIGNAL, countries: [{ id: "SD" }] },
      ),
      update: signalsUpdate,
    },
    signalLocationChallenges: { updateMany: txUpdateMany },
  };
  const prisma = {
    teamMembers: { findUnique: teamMembersFindUnique() },
    signalLocationChallenges: {
      findUnique: vi.fn().mockResolvedValueOnce(challenge).mockResolvedValue({ id: "C1", status: "decided" }),
      updateMany: outsideUpdateMany,
    },
    signals: { findUnique: vi.fn().mockResolvedValue("signal" in over ? over.signal : SIGNAL) },
    locations: {
      findUnique: vi.fn().mockResolvedValue({ ancestorIds: over.pointAncestors ?? ["D1", "SD-SD", "SD"] }),
      findFirst: vi.fn().mockResolvedValue("country" in over ? over.country : { id: "SD" }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { ctx: buildContext(user, prisma), lock, txUpdateMany, outsideUpdateMany, signalsUpdate };
}

describe("Mutation.decideSignalLocationChallenge: who decides", () => {
  it("throws NOT_FOUND for an unknown challenge", async () => {
    const { ctx } = decideCtx(TEAM_ADMIN, null);
    await expect(
      decideSignalLocationChallenge(null, { id: "nope", decision: "ACCEPT" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it.each([
    ["an analyst", OTHER_ANALYST],
    ["a team member", MEMBER],
    ["an admin of another team", OTHER_TEAMS_ADMIN],
  ])("refuses %s: only the team's admin decides", async (_who, user) => {
    const { ctx, signalsUpdate } = decideCtx(user);
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(signalsUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["a platform admin", PLATFORM],
    ["the team's admin", TEAM_ADMIN],
  ])("lets %s decide one they filed: an admin could override it anyway", async (_who, user) => {
    const { ctx, signalsUpdate } = decideCtx(user, { ...OPEN, createdBy: user.id });
    await decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx);
    expect(signalsUpdate).toHaveBeenCalled();
  });

  it("leaves a challenge filed with no team to a platform admin", async () => {
    const teamless = { ...OPEN, teamId: null };
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "DECLINE" }, decideCtx(TEAM_ADMIN, teamless).ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "DECLINE" }, decideCtx(PLATFORM, teamless).ctx),
    ).resolves.toBeTruthy();
  });

  it.each([
    ["superseded", /replaced by a newer one/],
    ["accepted", /already accepted/],
    ["declined", /already declined/],
  ])("throws CONFLICT on a %s challenge", async (status, message) => {
    const { ctx } = decideCtx(TEAM_ADMIN, { ...OPEN, status });
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" }, message: expect.stringMatching(message) });
  });
});

describe("Mutation.decideSignalLocationChallenge: input", () => {
  it("can't ACCEPT a bare challenge: there is no point to write", async () => {
    const { ctx } = decideCtx(TEAM_ADMIN, { ...OPEN, proposedLat: null, proposedLng: null, proposedName: null });
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("needs a point to CORRECT, and an in-range one", async () => {
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "CORRECT" }, decideCtx(TEAM_ADMIN).ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      decideSignalLocationChallenge(
        null, { id: "C1", decision: "CORRECT", point: { lat: 95, lng: 0 } }, decideCtx(TEAM_ADMIN).ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("takes a point only with CORRECT", async () => {
    const { ctx } = decideCtx(TEAM_ADMIN);
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "DECLINE", point: { lat: 1, lng: 2 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });
});

describe("Mutation.decideSignalLocationChallenge: DECLINE", () => {
  it("closes the challenge and leaves the signal as it is", async () => {
    const { ctx, outsideUpdateMany, signalsUpdate } = decideCtx(TEAM_ADMIN);
    await decideSignalLocationChallenge(null, { id: "C1", decision: "DECLINE" }, ctx);
    expect(outsideUpdateMany).toHaveBeenCalledWith({
      where: { id: "C1", status: "consideration" },
      data: { status: "declined", decidedBy: "u-admin", decidedAt: expect.any(Date) },
    });
    expect(signalsUpdate).not.toHaveBeenCalled();
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "signal.location_challenge.decline", resourceId: "S1" }),
    );
  });

  it("throws CONFLICT when it was decided meanwhile", async () => {
    const { ctx } = decideCtx(TEAM_ADMIN, OPEN, { count: 0 });
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "DECLINE" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });
});

describe("Mutation.decideSignalLocationChallenge: ACCEPT and CORRECT", () => {
  it("ACCEPT writes the proposed point onto the signal under a lock", async () => {
    const { ctx, lock, txUpdateMany, signalsUpdate } = decideCtx(TEAM_ADMIN);
    await decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx);

    expect(findOrCreateLandmarkL4).toHaveBeenCalledWith(expect.anything(), {
      name: "Nyala market",
      lat: 12.05,
      lng: 24.88,
      kind: "admin",
      withinId: "D1",
    });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(txUpdateMany).toHaveBeenCalledWith({
      where: { id: "C1", status: "consideration" },
      data: {
        status: "accepted",
        appliedLocationId: "P-new",
        decidedBy: "u-admin",
        decidedAt: expect.any(Date),
      },
    });
    expect(signalsUpdate).toHaveBeenCalledWith({
      where: { id: "S1" },
      data: {
        locationId: "P-new",
        originId: null,
        destinationId: null,
        locationCorrectedAt: expect.any(Date),
        countries: { set: [{ id: "SD" }] },
      },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "signal.location_challenge.accept",
        resourceId: "S1",
        metadata: {
          challengeId: "C1",
          appliedLocationId: "P-new",
          previous: { locationId: "P-in", originId: null, destinationId: null, countryIds: ["SD"] },
        },
      }),
    );
  });

  it("ACCEPT of a point without a name writes a plain point", async () => {
    const { ctx, signalsUpdate } = decideCtx(TEAM_ADMIN, { ...OPEN, proposedName: null });
    await decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx);
    expect(createPointLocation).toHaveBeenCalledWith(expect.anything(), 12.05, 24.88);
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
    expect(signalsUpdate.mock.calls[0]![0].data.locationId).toBe("P-plain");
  });

  it("CORRECT writes the admin's point instead and records it as corrected", async () => {
    const { ctx, txUpdateMany } = decideCtx(TEAM_ADMIN);
    await decideSignalLocationChallenge(
      null,
      { id: "C1", decision: "CORRECT", point: { lat: 12.1, lng: 24.9, name: " Kalma camp " } },
      ctx,
    );
    expect(findOrCreateLandmarkL4).toHaveBeenCalledWith(expect.anything(), {
      name: "Kalma camp",
      lat: 12.1,
      lng: 24.9,
      kind: "admin",
      withinId: "D1",
    });
    expect(txUpdateMany.mock.calls[0]![0].data).toMatchObject({ status: "corrected", appliedLocationId: "P-new" });
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "signal.location_challenge.correct" }),
    );
  });

  it("CORRECT can also fix a bare challenge", async () => {
    const bare = { ...OPEN, proposedLat: null, proposedLng: null, proposedName: null };
    const { ctx, signalsUpdate } = decideCtx(TEAM_ADMIN, bare);
    await decideSignalLocationChallenge(null, { id: "C1", decision: "CORRECT", point: { lat: 12.1, lng: 24.9 } }, ctx);
    expect(createPointLocation).toHaveBeenCalledWith(expect.anything(), 12.1, 24.9);
    expect(signalsUpdate).toHaveBeenCalled();
  });

  it("refuses a place outside the areas CLEAR covers, creating nothing", async () => {
    vi.mocked(resolveContainingAdminArea).mockResolvedValue(null);
    const { ctx, lock } = decideCtx(TEAM_ADMIN);
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it("refuses a place outside the team's area, unless a platform admin decides", async () => {
    vi.mocked(resolveContainingAdminArea).mockResolvedValue(OTHER_DISTRICT);
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, decideCtx(TEAM_ADMIN).ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();

    const { ctx, signalsUpdate } = decideCtx(PLATFORM, OPEN, { pointAncestors: ["D2", "SD-SD", "SD"] });
    await decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx);
    expect(findOrCreateLandmarkL4).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ withinId: "D2" }));
    expect(signalsUpdate).toHaveBeenCalled();
  });

  it("refuses a point that isn't under the checked area, writing nothing", async () => {
    // A point reused across a border would carry the neighbour's district.
    const { ctx, lock, signalsUpdate } = decideCtx(TEAM_ADMIN, OPEN, { pointAncestors: ["D9", "XX"] });
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "INTERNAL_SERVER_ERROR" } });
    expect(lock).not.toHaveBeenCalled();
    expect(signalsUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the signal left the team's area since it was filed, creating nothing", async () => {
    const { ctx } = decideCtx(TEAM_ADMIN, OPEN, { signal: { ...SIGNAL, locationId: "P-out" } });
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
  });

  it("re-checks under the lock: a signal moved out of the area meanwhile is not overwritten", async () => {
    const { ctx, txUpdateMany, signalsUpdate } = decideCtx(TEAM_ADMIN, OPEN, {
      locked: { ...SIGNAL, locationId: "P-out", countries: [] },
    });
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(txUpdateMany).not.toHaveBeenCalled();
    expect(signalsUpdate).not.toHaveBeenCalled();
  });

  it("throws CONFLICT, writing nothing onto the signal, when decided meanwhile", async () => {
    const { ctx, signalsUpdate } = decideCtx(TEAM_ADMIN, OPEN, { count: 0 });
    await expect(
      decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(signalsUpdate).not.toHaveBeenCalled();
  });

  it("leaves the signal's countries alone when the point has no country", async () => {
    const { ctx, signalsUpdate } = decideCtx(TEAM_ADMIN, OPEN, { country: null });
    await decideSignalLocationChallenge(null, { id: "C1", decision: "ACCEPT" }, ctx);
    expect(signalsUpdate.mock.calls[0]![0].data).not.toHaveProperty("countries");
  });
});

// ─── Queries ─────────────────────────────────────────────────────────────────

describe("Query.signalLocationChallenges", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(signalLocationChallenges(null, {}, buildContext(null))).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
  });

  it("defaults status to consideration and applies no signal filter without teamId", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await signalLocationChallenges(null, {}, buildContext(ANALYST, { signalLocationChallenges: { findMany } }));
    expect(findMany.mock.calls[0]![0].where).toEqual({ status: "consideration" });
  });

  it("applies no signal filter for a team with no locations (global monitoring)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(ANALYST, {
      signalLocationChallenges: { findMany },
      teamLocations: { findMany: vi.fn().mockResolvedValue([]) },
    });
    await signalLocationChallenges(null, { teamId: "T1", status: "declined" }, ctx);
    expect(findMany.mock.calls[0]![0].where).toEqual({ status: "declined" });
  });

  it("rejects an unknown status", async () => {
    const ctx = buildContext(ANALYST, { signalLocationChallenges: { findMany: vi.fn() } });
    await expect(signalLocationChallenges(null, { status: "open" }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });
});

describe("Query.signalLocationChallengesToDecide", () => {
  function listCtx(user: User, adminTeams: string[]) {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(user, {
      teamMembers: { findMany: vi.fn().mockResolvedValue(adminTeams.map((teamId) => ({ teamId }))) },
      signalLocationChallenges: { findMany },
    });
    return { ctx, findMany };
  }

  it("lists a team admin's teams' open challenges, newest first, their own included", async () => {
    const { ctx, findMany } = listCtx(TEAM_ADMIN, ["T1", "T3"]);
    await signalLocationChallengesToDecide(null, {}, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: { status: "consideration", teamId: { in: ["T1", "T3"] } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  it("is empty for someone who administers no team", async () => {
    const { ctx, findMany } = listCtx(ANALYST, []);
    await expect(signalLocationChallengesToDecide(null, {}, ctx)).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("narrows to one team, refusing a team the caller doesn't administer", async () => {
    const { ctx, findMany } = listCtx(TEAM_ADMIN, ["T1"]);
    await signalLocationChallengesToDecide(null, { teamId: "T1", first: 20 }, ctx);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ where: { teamId: "T1" }, take: 20 });
    await expect(signalLocationChallengesToDecide(null, { teamId: "T2" }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("lists every team's for a platform admin, their own included", async () => {
    const { ctx, findMany } = listCtx(PLATFORM, []);
    await signalLocationChallengesToDecide(null, {}, ctx);
    expect(findMany.mock.calls[0]![0].where).toEqual({ status: "consideration" });
  });

  it("rejects first outside 1..200", async () => {
    const { ctx } = listCtx(TEAM_ADMIN, ["T1"]);
    await expect(signalLocationChallengesToDecide(null, { first: 0 }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    await expect(signalLocationChallengesToDecide(null, { first: 201 }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });
});

describe("Query.locationPlacement", () => {
  it("returns the admin area containing the point", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "D1", name: "Nyala" });
    const out = await locationPlacement(null, { lat: 12.05, lng: 24.88 }, buildContext(ANALYST, { locations: { findUnique } }));
    expect(out).toEqual({ id: "D1", name: "Nyala" });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "D1" } });
  });

  it("is null outside the areas CLEAR covers", async () => {
    vi.mocked(resolveContainingAdminArea).mockResolvedValue(null);
    await expect(locationPlacement(null, { lat: 1, lng: 2 }, buildContext(ANALYST))).resolves.toBeNull();
  });

  it("rejects an out-of-range point", async () => {
    await expect(locationPlacement(null, { lat: 0, lng: 200 }, buildContext(ANALYST))).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });
});

// ─── Field resolvers ─────────────────────────────────────────────────────────

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
    expect(findFirst.mock.calls[0]![0].where).toEqual({ signalId: "S1", status: "consideration" });
  });
});

describe("SignalLocationChallenge fields", () => {
  it("hasProposedPoint is true only when both coordinates are set", () => {
    expect(hasProposedPoint({ proposedLng: 30, proposedLat: 15 })).toBe(true);
    expect(hasProposedPoint({ proposedLng: 30, proposedLat: null })).toBe(false);
    expect(hasProposedPoint({ proposedLng: null, proposedLat: null })).toBe(false);
  });

  it("proposedPlacement is null for a bare challenge, without a lookup", async () => {
    await expect(
      proposedPlacement({ proposedLat: null, proposedLng: null }, {}, buildContext(ANALYST)),
    ).resolves.toBeNull();
    expect(resolveContainingAdminArea).not.toHaveBeenCalled();
  });

  it("team is null for a challenge filed with no team", async () => {
    await expect(team({ teamId: null }, {}, buildContext(ANALYST))).resolves.toBeNull();
  });

  it("team is shown to the team's members and platform admins only", async () => {
    const teams = { findUnique: vi.fn().mockResolvedValue({ id: "T1", name: "Sudan team" }) };
    const prisma = { teamMembers: { findUnique: teamMembersFindUnique() }, teams };
    await expect(team({ teamId: "T1" }, {}, buildContext(MEMBER, prisma))).resolves.toMatchObject({ id: "T1" });
    await expect(team({ teamId: "T1" }, {}, buildContext(PLATFORM, prisma))).resolves.toMatchObject({ id: "T1" });
    teams.findUnique.mockClear();
    // An admin of another team sees no team, and its members aren't loaded.
    await expect(team({ teamId: "T1" }, {}, buildContext(OTHER_TEAMS_ADMIN, prisma))).resolves.toBeNull();
    expect(teams.findUnique).not.toHaveBeenCalled();
  });
});
