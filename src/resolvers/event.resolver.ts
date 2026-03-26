import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { resolveTeamMembership } from "../utils/auth-guard.js";
import { createPointLocation, createRegionFromPoints, getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { buildEventLocationFilterForTeam } from "../utils/location-scope.js";

interface CreateEventInput {
  title?: string;
  description?: string;
  descriptionSignals?: Record<string, unknown>;
  validFrom: string;
  validTo: string;
  firstSignalCreatedAt: string;
  lastSignalCreatedAt: string;
  originId?: string;
  destinationId?: string;
  locationId?: string;
  types: string[];
  populationAffected?: string;
  rank: number;
  signalIds: string[];
  lat?: number;
  lng?: number;
}

interface UpdateEventInput {
  title?: string;
  description?: string;
  descriptionSignals?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
  firstSignalCreatedAt?: string;
  lastSignalCreatedAt?: string;
  originId?: string;
  destinationId?: string;
  locationId?: string;
  types?: string[];
  populationAffected?: string;
  rank?: number;
  signalIds?: string[];
}

export const eventResolvers = {
  Query: {
    events: async (_parent: unknown, args: { teamId?: string }, context: Context) => {
      const user = requireAuth(context);
      if (!args.teamId) {
        if (user.role !== "admin") {
          throw new GraphQLError("teamId is required", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        return context.prisma.events.findMany();
      }
      await resolveTeamMembership(context.prisma, user.id, args.teamId, user.role);
      const filter = await buildEventLocationFilterForTeam(context.prisma, args.teamId);
      return context.prisma.events.findMany({ where: filter });
    },
    eventsByLocation: async (_parent: unknown, args: { locationId: string }, context: Context) => {
      requireAuth(context);
      const locationIds = await getLocationIdsWithDescendants(context.prisma, args.locationId);
      return context.prisma.events.findMany({
        where: {
          OR: [
            { originId: { in: locationIds } },
            { destinationId: { in: locationIds } },
            { locationId: { in: locationIds } },
          ],
        },
      });
    },
    event: async (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireAuth(context);
      const event = await context.prisma.events.findUnique({ where: { id: args.id } });
      if (!event) return null;
      if (user.role !== "admin") {
        // Events don't have a direct teamId; check via location-based team scope
        // For now, require admin access for single event lookups without team context
        const teamMemberships = await context.prisma.teamMembers.findMany({
          where: { userId: user.id },
          select: { teamId: true },
        });
        if (teamMemberships.length === 0) {
          throw new GraphQLError("No team membership found", {
            extensions: { code: "FORBIDDEN" },
          });
        }
        // Check if the event falls within any of the user's team scopes
        let accessible = false;
        for (const { teamId } of teamMemberships) {
          const filter = await buildEventLocationFilterForTeam(context.prisma, teamId);
          if (!filter) { accessible = true; break; } // global monitoring team
          const found = await context.prisma.events.findFirst({
            where: { id: args.id, ...filter },
          });
          if (found) { accessible = true; break; }
        }
        if (!accessible) {
          throw new GraphQLError("Event not accessible from your teams", {
            extensions: { code: "FORBIDDEN" },
          });
        }
      }
      return event;
    },
  },
  Mutation: {
    createEvent: async (
      _parent: unknown,
      args: { input: CreateEventInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      // Resolve location for the event
      let locationId = input.locationId;
      let originId = input.originId;
      let destinationId = input.destinationId;

      if (!locationId && !originId && !destinationId) {
        if (input.lat != null && input.lng != null) {
          // Single lat/lng provided — create a point location
          const pointLoc = await createPointLocation(
            context.prisma, input.lat, input.lng, input.title ?? undefined,
          );
          locationId = pointLoc.id;
        } else if (input.signalIds.length > 0) {
          // No explicit location — gather point geometries from linked signals
          const signalLocations = await context.prisma.signals.findMany({
            where: { id: { in: input.signalIds } },
            select: { locationId: true, originId: true, destinationId: true },
          });

          // Collect unique location IDs from signals
          const locIds = new Set<string>();
          for (const sl of signalLocations) {
            if (sl.locationId) locIds.add(sl.locationId);
            if (sl.originId) locIds.add(sl.originId);
            if (sl.destinationId) locIds.add(sl.destinationId);
          }

          if (locIds.size > 0) {
            // Fetch point geometries for these locations
            const locPoints = await context.prisma.$queryRaw<
              Array<{ lat: number; lng: number }>
            >`
              SELECT ST_Y("geometry"::geometry) as lat, ST_X("geometry"::geometry) as lng
              FROM "locations"
              WHERE id = ANY(${[...locIds]}::text[])
                AND "geometry" IS NOT NULL
                AND ST_GeometryType("geometry"::geometry) = 'ST_Point'
            `;

            if (locPoints.length === 1) {
              // Single point — reuse the signal's location directly
              locationId = [...locIds][0]!;
            } else if (locPoints.length > 1) {
              // Multiple points — create a convex hull region
              const region = await createRegionFromPoints(
                context.prisma, locPoints, input.title ?? undefined,
              );
              locationId = region.id;
            }
          }
        }
      }

      const event = await context.prisma.events.create({
        data: {
          title: input.title,
          description: input.description,
          description_signals: input.descriptionSignals
            ? (input.descriptionSignals as InputJsonValue)
            : undefined,
          validFrom: new Date(input.validFrom),
          validTo: new Date(input.validTo),
          firstSignalCreatedAt: new Date(input.firstSignalCreatedAt),
          lastSignalCreatedAt: new Date(input.lastSignalCreatedAt),
          originId,
          destinationId,
          locationId,
          types: input.types,
          populationAffected: input.populationAffected
            ? BigInt(input.populationAffected)
            : undefined,
          rank: input.rank,
        },
      });

      // Create signalEvents join entries
      if (input.signalIds.length > 0) {
        await context.prisma.signalEvents.createMany({
          data: input.signalIds.map((signalId) => ({
            signalId,
            eventId: event.id,
            collectedAt: new Date(),
          })),
        });
      }

      return event;
    },

    updateEvent: async (
      _parent: unknown,
      args: { id: string; input: UpdateEventInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { id, input } = args;

      const existing = await context.prisma.events.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Update signal links if provided
      if (input.signalIds !== undefined) {
        await context.prisma.signalEvents.deleteMany({ where: { eventId: id } });
        if (input.signalIds.length > 0) {
          await context.prisma.signalEvents.createMany({
            data: input.signalIds.map((signalId) => ({
              signalId,
              eventId: id,
              collectedAt: new Date(),
            })),
          });
        }
      }

      return context.prisma.events.update({
        where: { id },
        data: {
          title: input.title ?? undefined,
          description: input.description ?? undefined,
          description_signals: input.descriptionSignals
            ? (input.descriptionSignals as InputJsonValue)
            : undefined,
          validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
          validTo: input.validTo ? new Date(input.validTo) : undefined,
          firstSignalCreatedAt: input.firstSignalCreatedAt
            ? new Date(input.firstSignalCreatedAt)
            : undefined,
          lastSignalCreatedAt: input.lastSignalCreatedAt
            ? new Date(input.lastSignalCreatedAt)
            : undefined,
          originId: input.originId,
          destinationId: input.destinationId,
          locationId: input.locationId,
          types: input.types ?? undefined,
          populationAffected: input.populationAffected !== undefined
            ? BigInt(input.populationAffected)
            : undefined,
          rank: input.rank ?? undefined,
        },
      });
    },

    deleteEvent: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.events.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.events.delete({ where: { id: args.id } });
      return true;
    },
  },
  Event: {
    signals: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.signalEvents.findMany({
        where: { eventId: parent.id },
        include: { signal: true },
      }).then((links) => links.map((l) => l.signal));
    },
    originLocation: (parent: { originId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.originId) return null;
      return prisma.locations.findUnique({ where: { id: parent.originId } });
    },
    destinationLocation: (parent: { destinationId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.destinationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.destinationId } });
    },
    generalLocation: (parent: { locationId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.locationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.locationId } });
    },
    alerts: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alerts.findMany({ where: { eventId: parent.id } });
    },
    feedbacks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userFeedbacks.findMany({ where: { eventId: parent.id } });
    },
    comments: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userComments.findMany({ where: { eventId: parent.id } });
    },
    populationAffected: (parent: { populationAffected: bigint | null }) => {
      return parent.populationAffected?.toString() ?? null;
    },
    escalations: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.eventEscaladedByUsers.findMany({ where: { eventId: parent.id } });
    },
  },
  EventEscalation: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    event: (parent: { eventId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.events.findUnique({ where: { id: parent.eventId } });
    },
  },
};
