import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import {
  isPlatformAdmin,
  requireContentReader,
  requireNonWorkerContentReader,
} from "../utils/auth-guard.js";
import { getTeamScopeLocationIds } from "../utils/location-scope.js";
import { findOrCreateLandmarkL4, resolveLatLngToLocation } from "../utils/geo-resolve.js";
import { logActivity } from "../utils/activity-log.js";

// ─── Event location change requests ──────────────────────────────────────────
// An analyst or ERM proposes a new place for an Event on behalf of their team;
// that team's team_admin accepts or rejects it. The place is any point (a
// geocoder hit): on accept it becomes a named level-4 point location under the
// admin area that contains it. Only the Event moves; its signals do not.

const PENDING = "pending";
const PROPOSER_ROLES: ReadonlySet<string> = new Set(["analyst", "emergency_response_manager"]);
const DECIDER_ROLE = "team_admin";
const NOTE_MAX = 2000;
const NAME_MAX = 200;

interface ProposeInput {
  eventId: string;
  teamId: string;
  lat: number;
  lng: number;
  name: string;
  note?: string | null;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

/** Trim to null (empty → null); reject when over `max`. */
function trimText(value: string | null | undefined, max: number, field: string): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw badInput(`${field} must be at most ${max} characters.`);
  return trimmed;
}

function assertPoint(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw badInput("lat must be between -90 and 90.");
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw badInput("lng must be between -180 and 180.");
}

/** The caller's role on `teamId`, or null. */
async function teamRole(context: Context, userId: string, teamId: string): Promise<string | null> {
  const membership = await context.prisma.teamMembers.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });
  return membership?.role ?? null;
}

/** Platform admin, or a team_admin of `teamId`. */
async function requireTeamDecider(context: Context, teamId: string) {
  const user = requireNonWorkerContentReader(context);
  if (isPlatformAdmin(user)) return user;
  if ((await teamRole(context, user.id, teamId)) === DECIDER_ROLE) return user;
  throw new GraphQLError("Requires the team's team_admin, or global admin", {
    extensions: { code: "FORBIDDEN" },
  });
}

/** Country (level 0) of a location: itself, or the level-0 row among its ancestors. */
async function countryOf(context: Context, locationId: string): Promise<string | null> {
  const loc = await context.prisma.locations.findUnique({
    where: { id: locationId },
    select: { id: true, level: true, ancestorIds: true },
  });
  if (!loc) return null;
  if (loc.level === 0) return loc.id;
  if (loc.ancestorIds.length === 0) return null;
  const country = await context.prisma.locations.findFirst({
    where: { id: { in: loc.ancestorIds }, level: 0 },
    select: { id: true },
  });
  return country?.id ?? null;
}

export const eventLocationChangeResolvers = {
  Query: {
    eventLocationChangeRequests: async (
      _parent: unknown,
      args: { teamId: string; status?: string | null },
      context: Context,
    ) => {
      await requireTeamDecider(context, args.teamId);
      return context.prisma.eventLocationChangeRequests.findMany({
        where: { teamId: args.teamId, status: args.status ?? PENDING },
        orderBy: { createdAt: "desc" },
      });
    },

    locationPlacement: async (
      _parent: unknown,
      args: { lat: number; lng: number },
      context: Context,
    ) => {
      requireContentReader(context);
      assertPoint(args.lat, args.lng);
      const placed = await resolveLatLngToLocation(context.prisma, args.lat, args.lng);
      if (!placed) return null;
      return context.prisma.locations.findUnique({ where: { id: placed.id } });
    },
  },

  Mutation: {
    proposeEventLocationChange: async (
      _parent: unknown,
      { input }: { input: ProposeInput },
      context: Context,
    ) => {
      const user = requireNonWorkerContentReader(context);
      if (!isPlatformAdmin(user)) {
        const role = await teamRole(context, user.id, input.teamId);
        if (!role || !PROPOSER_ROLES.has(role)) {
          throw new GraphQLError(
            "Requires an analyst or emergency_response_manager role on this team",
            { extensions: { code: "FORBIDDEN" } },
          );
        }
      }

      assertPoint(input.lat, input.lng);
      const name = trimText(input.name, NAME_MAX, "name");
      if (!name) throw badInput("name is required.");
      const note = trimText(input.note, NOTE_MAX, "note");

      const event = await context.prisma.events.findUnique({
        where: { id: input.eventId },
        select: { id: true, originId: true, destinationId: true, locationId: true },
      });
      if (!event) {
        throw new GraphQLError("Event not found", { extensions: { code: "NOT_FOUND" } });
      }

      // The Event must be one the team works on. A team with no scope is
      // global monitoring; an Event with no location at all is open to any team.
      const scope = await getTeamScopeLocationIds(context.prisma, input.teamId);
      const eventLocs = [event.originId, event.destinationId, event.locationId].filter(
        (x): x is string => Boolean(x),
      );
      if (scope && eventLocs.length > 0 && !eventLocs.some((id) => scope.includes(id))) {
        throw new GraphQLError("This event is outside the team's location scope", {
          extensions: { code: "FORBIDDEN" },
        });
      }

      // Fail now rather than on accept: a point outside every loaded admin
      // area would leave the Event with no country and no district.
      if (!(await resolveLatLngToLocation(context.prisma, input.lat, input.lng))) {
        throw badInput("The proposed place is outside the areas CLEAR covers.");
      }

      const fields = {
        createdBy: user.id,
        note,
        proposedLat: input.lat,
        proposedLng: input.lng,
        proposedName: name,
        previousLocationId: event.locationId ?? event.originId ?? event.destinationId ?? null,
      };
      // One pending request per Event and team (a partial unique index backs
      // this): a re-proposal replaces the open one.
      const open = await context.prisma.eventLocationChangeRequests.findFirst({
        where: { eventId: event.id, teamId: input.teamId, status: PENDING },
        select: { id: true },
      });
      const request = open
        ? await context.prisma.eventLocationChangeRequests.update({ where: { id: open.id }, data: fields })
        : await context.prisma.eventLocationChangeRequests.create({
            data: { eventId: event.id, teamId: input.teamId, status: PENDING, ...fields },
          });

      void logActivity(context.prisma, {
        userId: user.id,
        action: "event.location_change.propose",
        resourceType: "event",
        resourceId: event.id,
        metadata: { requestId: request.id, teamId: input.teamId, name, lat: input.lat, lng: input.lng },
      });
      return request;
    },

    decideEventLocationChange: async (
      _parent: unknown,
      args: { id: string; accept: boolean; note?: string | null },
      context: Context,
    ) => {
      requireNonWorkerContentReader(context);
      const request = await context.prisma.eventLocationChangeRequests.findUnique({
        where: { id: args.id },
      });
      if (!request) {
        throw new GraphQLError("Change request not found", { extensions: { code: "NOT_FOUND" } });
      }
      const user = await requireTeamDecider(context, request.teamId);
      if (request.status !== PENDING) {
        throw new GraphQLError(`This request is already ${request.status}`, {
          extensions: { code: "CONFLICT" },
        });
      }
      const decisionNote = trimText(args.note, NOTE_MAX, "note");
      const decided = {
        decidedBy: user.id,
        decidedAt: new Date(),
        decisionNote,
      };

      if (!args.accept) {
        // Conditional on still pending, so a concurrent decision wins once.
        const { count } = await context.prisma.eventLocationChangeRequests.updateMany({
          where: { id: request.id, status: PENDING },
          data: { status: "rejected", ...decided },
        });
        if (count === 0) {
          throw new GraphQLError("This request was decided in the meantime", {
            extensions: { code: "CONFLICT" },
          });
        }
        void logActivity(context.prisma, {
          userId: user.id,
          action: "event.location_change.reject",
          resourceType: "event",
          resourceId: request.eventId,
          metadata: { requestId: request.id },
        });
        return context.prisma.eventLocationChangeRequests.findUnique({ where: { id: request.id } });
      }

      // Reuse a same-name point within 100 m in the same district, else create
      // one under the containing admin area. Tagged landmark-geocoded so the
      // app shows its own name (a village), not its district's. Outside the
      // transaction: it is idempotent, and a point left by a lost race is
      // reused next time.
      const point = await findOrCreateLandmarkL4(context.prisma, {
        name: request.proposedName,
        lat: request.proposedLat,
        lng: request.proposedLng,
        kind: "admin",
      });
      if (!point.locationId) {
        throw new GraphQLError("The proposed place could not be placed", {
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        });
      }
      const pointId = point.locationId;
      const countryId = await countryOf(context, pointId);

      await context.prisma.$transaction(async (tx) => {
        const { count } = await tx.eventLocationChangeRequests.updateMany({
          where: { id: request.id, status: PENDING },
          data: { status: "accepted", appliedLocationId: pointId, ...decided },
        });
        if (count === 0) {
          throw new GraphQLError("This request was decided in the meantime", {
            extensions: { code: "CONFLICT" },
          });
        }
        // The Event is now "happening here": general location only, so the
        // grouping key (first of origin/general/destination) is this point.
        await tx.events.update({
          where: { id: request.eventId },
          data: {
            locationId: pointId,
            originId: null,
            destinationId: null,
            ...(countryId ? { countries: { set: [{ id: countryId }] } } : {}),
          },
        });
      });

      void logActivity(context.prisma, {
        userId: user.id,
        action: "event.location_change.accept",
        resourceType: "event",
        resourceId: request.eventId,
        metadata: {
          requestId: request.id,
          previousLocationId: request.previousLocationId,
          appliedLocationId: pointId,
        },
      });
      return context.prisma.eventLocationChangeRequests.findUnique({ where: { id: request.id } });
    },
  },

  EventLocationChangeRequest: {
    event: (parent: { eventId: string }, _args: unknown, { prisma }: Context) =>
      prisma.events.findUnique({ where: { id: parent.eventId } }),
    team: (parent: { teamId: string }, _args: unknown, { prisma }: Context) =>
      prisma.teams.findUnique({ where: { id: parent.teamId } }),
    previousLocation: (parent: { previousLocationId: string | null }, _args: unknown, { prisma }: Context) =>
      parent.previousLocationId
        ? prisma.locations.findUnique({ where: { id: parent.previousLocationId } })
        : null,
    appliedLocation: (parent: { appliedLocationId: string | null }, _args: unknown, { prisma }: Context) =>
      parent.appliedLocationId
        ? prisma.locations.findUnique({ where: { id: parent.appliedLocationId } })
        : null,
    createdByName: async (parent: { createdBy: string }, _args: unknown, { prisma }: Context) => {
      const u = await prisma.user.findUnique({ where: { id: parent.createdBy }, select: { name: true } });
      return u?.name ?? null;
    },
  },
};
