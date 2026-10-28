/**
 * Unit tests for `eventLocationChange.resolver.ts`, DB-free.
 *
 * `context.prisma.*` is stubbed with `vi.fn()` delegates and the geo / scope
 * helpers are mocked. Covers who may propose (team analyst or ERM, in scope),
 * input validation, one pending request per event and team, who may list and
 * decide (the request team's team_admin), reject, and accept moving only the
 * Event to a created-or-reused point location.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.js";
import type { Context } from "../../src/context.js";

const resolveLatLngToLocation = vi.fn();
const findOrCreateLandmarkL4 = vi.fn();
const getTeamScopeLocationIds = vi.fn();
vi.mock("../../src/utils/geo-resolve.js", () => ({ resolveLatLngToLocation, findOrCreateLandmarkL4 }));
vi.mock("../../src/utils/location-scope.js", () => ({ getTeamScopeLocationIds }));
vi.mock("../../src/utils/activity-log.js", () => ({ logActivity: vi.fn() }));

const { logActivity } = await import("../../src/utils/activity-log.js");
const { eventLocationChangeResolvers } = await import("../../src/resolvers/eventLocationChange.resolver.js");
const { proposeEventLocationChange, decideEventLocationChange } = eventLocationChangeResolvers.Mutation;
const { eventLocationChangeRequests, locationPlacement } = eventLocationChangeResolvers.Query;

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

const MEMBER = { id: "u1", role: "member" };
const ADMIN = { id: "u-admin", role: "admin" };
const DISTRICT = { id: "A2-haya", name: "Haya", level: 2 };
const EVENT = { id: "E1", originId: null, destinationId: null, locationId: "A2-old" };

function membership(role: string | null) {
  return { findUnique: vi.fn().mockResolvedValue(role ? { role } : null) };
}

const proposal = {
  eventId: "E1",
  teamId: "T1",
  lat: 18.3,
  lng: 36.4,
  name: "  Village X  ",
  note: " wrong district ",
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveLatLngToLocation.mockResolvedValue(DISTRICT);
  getTeamScopeLocationIds.mockResolvedValue(undefined); // global monitoring
});

describe("Mutation.proposeEventLocationChange", () => {
  function proposeCtx(role: string | null, extra: Record<string, unknown> = {}, user: User = MEMBER) {
    return buildContext(user, {
      teamMembers: membership(role),
      events: { findUnique: vi.fn().mockResolvedValue(EVENT) },
      eventLocationChangeRequests: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => ({ id: "R1", ...data })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ id: "R-open", status: "pending" }),
      },
      ...extra,
    });
  }

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      proposeEventLocationChange(null, { input: proposal }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it.each(["team_member", "team_admin", null])("rejects a %s", async (role) => {
    await expect(
      proposeEventLocationChange(null, { input: proposal }, proposeCtx(role)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it.each(["analyst", "emergency_response_manager"])("lets a team %s propose", async (role) => {
    const ctx = proposeCtx(role);
    const result = await proposeEventLocationChange(null, { input: proposal }, ctx);
    expect(result).toMatchObject({
      id: "R1",
      eventId: "E1",
      teamId: "T1",
      status: "pending",
      createdBy: "u1",
      proposedName: "Village X",
      note: "wrong district",
      proposedLat: 18.3,
      proposedLng: 36.4,
      previousLocationId: "A2-old",
    });
  });

  it("never touches the Event", async () => {
    const eventsUpdate = vi.fn();
    const ctx = proposeCtx("analyst", {
      events: { findUnique: vi.fn().mockResolvedValue(EVENT), update: eventsUpdate },
    });
    await proposeEventLocationChange(null, { input: proposal }, ctx);
    expect(eventsUpdate).not.toHaveBeenCalled();
  });

  it("replaces the team's open request for the event", async () => {
    const ctx = proposeCtx("analyst");
    const requests = (ctx.prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
      .eventLocationChangeRequests;
    requests.findFirst.mockResolvedValue({ id: "R-open" });
    const result = await proposeEventLocationChange(null, { input: proposal }, ctx);
    // Only while still pending: a request decided meanwhile is never rewritten.
    expect(requests.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "R-open", status: "pending" } }),
    );
    expect(requests.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "R-open" });
  });

  it("files a new request when the open one was decided meanwhile", async () => {
    const ctx = proposeCtx("analyst");
    const requests = (ctx.prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
      .eventLocationChangeRequests;
    requests.findFirst.mockResolvedValue({ id: "R-open" });
    requests.updateMany.mockResolvedValue({ count: 0 });
    const result = await proposeEventLocationChange(null, { input: proposal }, ctx);
    expect(requests.create).toHaveBeenCalled();
    expect(result).toMatchObject({ id: "R1", status: "pending" });
  });

  it("answers a proposal filed at the same moment with CONFLICT", async () => {
    const ctx = proposeCtx("analyst");
    const requests = (ctx.prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
      .eventLocationChangeRequests;
    requests.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
    );
    await expect(
      proposeEventLocationChange(null, { input: proposal }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });

  it("rejects an out-of-range latitude", async () => {
    await expect(
      proposeEventLocationChange(null, { input: { ...proposal, lat: 95 } }, proposeCtx("analyst")),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("requires a name", async () => {
    await expect(
      proposeEventLocationChange(null, { input: { ...proposal, name: "   " } }, proposeCtx("analyst")),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("throws NOT_FOUND for an unknown event", async () => {
    const ctx = proposeCtx("analyst", { events: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      proposeEventLocationChange(null, { input: proposal }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("rejects an event outside the team's scope", async () => {
    getTeamScopeLocationIds.mockResolvedValue(["A0-sudan", "A2-haya"]);
    await expect(
      proposeEventLocationChange(null, { input: proposal }, proposeCtx("analyst")),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("accepts an event inside the team's scope", async () => {
    getTeamScopeLocationIds.mockResolvedValue(["A0-sudan", "A2-old", "A2-haya"]);
    await expect(
      proposeEventLocationChange(null, { input: proposal }, proposeCtx("analyst")),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("rejects a place outside the team's area", async () => {
    // The Event (A2-old) is the team's, the proposed place (A2-haya) is not.
    getTeamScopeLocationIds.mockResolvedValue(["A0-sudan", "A2-old"]);
    const ctx = proposeCtx("analyst");
    await expect(
      proposeEventLocationChange(null, { input: proposal }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const requests = (ctx.prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
      .eventLocationChangeRequests;
    expect(requests.create).not.toHaveBeenCalled();
  });

  it("lets a platform admin propose a place outside the team's area", async () => {
    getTeamScopeLocationIds.mockResolvedValue(["A0-sudan", "A2-old"]);
    await expect(
      proposeEventLocationChange(null, { input: proposal }, proposeCtx(null, {}, ADMIN)),
    ).resolves.toMatchObject({ status: "pending", createdBy: "u-admin" });
  });

  it("rejects a point outside every loaded area", async () => {
    resolveLatLngToLocation.mockResolvedValue(null);
    await expect(
      proposeEventLocationChange(null, { input: proposal }, proposeCtx("analyst")),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });
});

describe("Query.eventLocationChangeRequests", () => {
  it("is forbidden to a team analyst", async () => {
    const ctx = buildContext(MEMBER, { teamMembers: membership("analyst") });
    await expect(
      eventLocationChangeRequests(null, { teamId: "T1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("lists the team's pending requests for its team_admin", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(MEMBER, {
      teamMembers: membership("team_admin"),
      eventLocationChangeRequests: { findMany },
    });
    await eventLocationChangeRequests(null, { teamId: "T1" }, ctx);
    expect(findMany.mock.calls[0][0].where).toEqual({ teamId: "T1", status: "pending" });
  });

  it("rejects an unknown status", async () => {
    const ctx = buildContext(MEMBER, { teamMembers: membership("team_admin") });
    await expect(
      eventLocationChangeRequests(null, { teamId: "T1", status: "open" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });
});

describe("Query.locationPlacement", () => {
  it("returns the containing admin area without creating anything", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "A2-haya", name: "Haya" });
    const ctx = buildContext(MEMBER, { locations: { findUnique } });
    await expect(locationPlacement(null, { lat: 18.3, lng: 36.4 }, ctx)).resolves.toMatchObject({ id: "A2-haya" });
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
  });

  it("returns null outside every loaded area", async () => {
    resolveLatLngToLocation.mockResolvedValue(null);
    await expect(locationPlacement(null, { lat: 0, lng: 0 }, buildContext(MEMBER))).resolves.toBeNull();
  });
});

describe("Mutation.decideEventLocationChange", () => {
  const PENDING_REQUEST = {
    id: "R1",
    eventId: "E1",
    teamId: "T1",
    status: "pending",
    proposedLat: 18.3,
    proposedLng: 36.4,
    proposedName: "Village X",
    previousLocationId: "A2-old",
  };

  function decideCtx(user: User, role: string | null, request: unknown = PENDING_REQUEST) {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const eventsUpdate = vi.fn().mockResolvedValue({});
    const tx = { eventLocationChangeRequests: { updateMany }, events: { update: eventsUpdate } };
    const ctx = buildContext(user, {
      teamMembers: membership(role),
      eventLocationChangeRequests: {
        findUnique: vi.fn().mockResolvedValue(request),
        updateMany,
      },
      events: {
        findUnique: vi.fn().mockResolvedValue({
          originId: "A2-origin",
          destinationId: "A2-destination",
          locationId: "A2-old",
          countries: [{ id: "A0-sudan" }, { id: "A0-chad" }],
        }),
      },
      locations: {
        findUnique: vi.fn().mockResolvedValue({ id: "A4-village", level: 4, ancestorIds: ["A2-haya", "A1-red-sea", "A0-sudan"] }),
        findFirst: vi.fn().mockResolvedValue({ id: "A0-sudan" }),
      },
      $transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)),
    });
    return { ctx, updateMany, eventsUpdate };
  }

  it.each(["analyst", "emergency_response_manager", "team_member"])("is forbidden to a team %s", async (role) => {
    const { ctx } = decideCtx(MEMBER, role);
    await expect(
      decideEventLocationChange(null, { id: "R1", accept: true }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND for an unknown request", async () => {
    const { ctx } = decideCtx(MEMBER, "team_admin", null);
    await expect(
      decideEventLocationChange(null, { id: "nope", accept: true }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("refuses a request that is already decided", async () => {
    const { ctx } = decideCtx(MEMBER, "team_admin", { ...PENDING_REQUEST, status: "accepted" });
    await expect(
      decideEventLocationChange(null, { id: "R1", accept: false }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });

  it("rejects without moving the Event", async () => {
    const { ctx, updateMany, eventsUpdate } = decideCtx(MEMBER, "team_admin");
    await decideEventLocationChange(null, { id: "R1", accept: false, note: " not convinced " }, ctx);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "R1", status: "pending" },
      data: expect.objectContaining({ status: "rejected", decidedBy: "u1", decisionNote: "not convinced" }),
    });
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
    expect(eventsUpdate).not.toHaveBeenCalled();
  });

  it("on accept, moves the Event to a created-or-reused point and sets its country", async () => {
    findOrCreateLandmarkL4.mockResolvedValue({ locationId: "A4-village", reused: false, pointType: "landmark-geocoded", abortedReason: null });
    const { ctx, updateMany, eventsUpdate } = decideCtx(MEMBER, "team_admin");
    await decideEventLocationChange(null, { id: "R1", accept: true }, ctx);
    expect(findOrCreateLandmarkL4).toHaveBeenCalledWith(ctx.prisma, { name: "Village X", lat: 18.3, lng: 36.4, kind: "admin" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "R1", status: "pending" },
      data: expect.objectContaining({ status: "accepted", appliedLocationId: "A4-village", decidedBy: "u1" }),
    });
    expect(eventsUpdate).toHaveBeenCalledWith({
      where: { id: "E1" },
      data: {
        locationId: "A4-village",
        originId: null,
        destinationId: null,
        countries: { set: [{ id: "A0-sudan" }] },
      },
    });
  });

  it("logs what the move overwrote, so it can be undone", async () => {
    findOrCreateLandmarkL4.mockResolvedValue({ locationId: "A4-village", reused: false, pointType: "landmark-geocoded", abortedReason: null });
    const { ctx } = decideCtx(MEMBER, "team_admin");
    await decideEventLocationChange(null, { id: "R1", accept: true }, ctx);
    expect(vi.mocked(logActivity)).toHaveBeenCalledWith(ctx.prisma, expect.objectContaining({
      action: "event.location_change.accept",
      resourceId: "E1",
      metadata: {
        requestId: "R1",
        appliedLocationId: "A4-village",
        previous: {
          locationId: "A2-old",
          originId: "A2-origin",
          destinationId: "A2-destination",
          countryIds: ["A0-sudan", "A0-chad"],
        },
      },
    }));
  });

  it("refuses to accept once the Event is outside the team's scope, creating nothing", async () => {
    getTeamScopeLocationIds.mockResolvedValue(["A0-afghanistan"]);
    const { ctx, updateMany, eventsUpdate } = decideCtx(MEMBER, "team_admin");
    await expect(
      decideEventLocationChange(null, { id: "R1", accept: true }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(eventsUpdate).not.toHaveBeenCalled();
  });

  it("refuses a team_admin a place outside the team's area, creating nothing", async () => {
    // The Event is the team's (A2-old), the proposed place (A2-haya) is not.
    getTeamScopeLocationIds.mockResolvedValue(["A0-sudan", "A2-old"]);
    const { ctx, updateMany, eventsUpdate } = decideCtx(MEMBER, "team_admin");
    await expect(
      decideEventLocationChange(null, { id: "R1", accept: true }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(eventsUpdate).not.toHaveBeenCalled();
  });

  it("lets a platform admin accept a place outside the team's area", async () => {
    getTeamScopeLocationIds.mockResolvedValue(["A0-sudan", "A2-old"]);
    findOrCreateLandmarkL4.mockResolvedValue({ locationId: "A4-village", reused: false, pointType: "landmark-geocoded", abortedReason: null });
    const { ctx, eventsUpdate } = decideCtx(ADMIN, null);
    await decideEventLocationChange(null, { id: "R1", accept: true }, ctx);
    expect(eventsUpdate).toHaveBeenCalled();
  });

  it("refuses to accept a place no longer inside any loaded area", async () => {
    resolveLatLngToLocation.mockResolvedValue(null);
    const { ctx, eventsUpdate } = decideCtx(ADMIN, null);
    await expect(
      decideEventLocationChange(null, { id: "R1", accept: true }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
    expect(eventsUpdate).not.toHaveBeenCalled();
  });

  it("still lets the team_admin reject a request for an Event outside the scope", async () => {
    getTeamScopeLocationIds.mockResolvedValue(["A0-afghanistan"]);
    const { ctx, updateMany } = decideCtx(MEMBER, "team_admin");
    await decideEventLocationChange(null, { id: "R1", accept: false }, ctx);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "rejected" }) }));
  });

  it("lets a platform admin decide without a team membership", async () => {
    findOrCreateLandmarkL4.mockResolvedValue({ locationId: "A4-village", reused: false, pointType: "landmark-geocoded", abortedReason: null });
    const { ctx, eventsUpdate } = decideCtx(ADMIN, null);
    await decideEventLocationChange(null, { id: "R1", accept: true }, ctx);
    expect(eventsUpdate).toHaveBeenCalled();
  });

  it("fails if another decision won the race", async () => {
    findOrCreateLandmarkL4.mockResolvedValue({ locationId: "A4-village", reused: false, pointType: "landmark-geocoded", abortedReason: null });
    const { ctx, updateMany, eventsUpdate } = decideCtx(MEMBER, "team_admin");
    updateMany.mockResolvedValue({ count: 0 });
    await expect(
      decideEventLocationChange(null, { id: "R1", accept: true }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(eventsUpdate).not.toHaveBeenCalled();
  });
});

describe("EventLocationChangeRequest.proposedPlacement", () => {
  const { proposedPlacement } = eventLocationChangeResolvers.EventLocationChangeRequest;

  it("resolves the admin area the proposed point falls in", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "A2-haya", name: "Haya" });
    const ctx = buildContext(MEMBER, { locations: { findUnique } });
    await expect(proposedPlacement({ proposedLat: 18.3, proposedLng: 36.4 }, {}, ctx)).resolves.toMatchObject({ id: "A2-haya" });
    expect(resolveLatLngToLocation).toHaveBeenCalledWith(ctx.prisma, 18.3, 36.4);
  });
});
