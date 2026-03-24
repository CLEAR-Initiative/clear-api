import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { AlertStatus } from "../generated/prisma/client.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { resolveTeamMembership } from "../utils/auth-guard.js";
import { getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { buildEventLocationFilterForTeam } from "../utils/location-scope.js";

interface CreateAlertInput {
  eventId: string;
  status?: AlertStatus;
}

interface UpdateAlertInput {
  status?: AlertStatus;
}

export const alertResolvers = {
  Query: {
    alerts: async (_parent: unknown, args: { status?: AlertStatus; teamId?: string }, context: Context) => {
      const user = requireAuth(context);
      if (!args.teamId) {
        if (user.role !== "admin") {
          throw new GraphQLError("teamId is required", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        return context.prisma.alerts.findMany({
          where: args.status ? { status: args.status } : undefined,
        });
      }
      await resolveTeamMembership(context.prisma, user.id, args.teamId, user.role);
      const eventLocationFilter = await buildEventLocationFilterForTeam(context.prisma, args.teamId);
      return context.prisma.alerts.findMany({
        where: {
          ...(args.status ? { status: args.status } : {}),
          ...(eventLocationFilter ? { event: eventLocationFilter } : {}),
        },
      });
    },
    alertsByLocation: async (
      _parent: unknown,
      args: { locationId: string; status?: AlertStatus },
      context: Context,
    ) => {
      requireAuth(context);
      const locationIds = await getLocationIdsWithDescendants(context.prisma, args.locationId);
      return context.prisma.alerts.findMany({
        where: {
          ...(args.status ? { status: args.status } : {}),
          event: {
            OR: [
              { originId: { in: locationIds } },
              { destinationId: { in: locationIds } },
              { locationId: { in: locationIds } },
            ],
          },
        },
      });
    },
    alert: async (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireAuth(context);
      const alert = await context.prisma.alerts.findUnique({
        where: { id: args.id },
        include: { event: true },
      });
      if (!alert) return null;
      if (user.role !== "admin") {
        const teamMemberships = await context.prisma.teamMembers.findMany({
          where: { userId: user.id },
          select: { teamId: true },
        });
        if (teamMemberships.length === 0) {
          throw new GraphQLError("No team membership found", {
            extensions: { code: "FORBIDDEN" },
          });
        }
        let accessible = false;
        for (const { teamId } of teamMemberships) {
          const eventFilter = await buildEventLocationFilterForTeam(context.prisma, teamId);
          if (!eventFilter) { accessible = true; break; }
          const found = await context.prisma.alerts.findFirst({
            where: { id: args.id, event: eventFilter },
          });
          if (found) { accessible = true; break; }
        }
        if (!accessible) {
          throw new GraphQLError("Alert not accessible from your teams", {
            extensions: { code: "FORBIDDEN" },
          });
        }
      }
      // Return without the included event to match the type
      const { event: _event, ...alertData } = alert;
      return alertData;
    },
  },
  Mutation: {
    createAlert: async (
      _parent: unknown,
      args: { input: CreateAlertInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      // Verify the event exists
      const event = await context.prisma.events.findUnique({
        where: { id: input.eventId },
      });
      if (!event) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Create the alert record
      const alert = await context.prisma.alerts.create({
        data: {
          eventId: input.eventId,
          status: input.status ?? "draft",
        },
      });

      // Find subscribers matching the event's types and locations
      const eventLocationIds = [
        event.originId,
        event.destinationId,
        event.locationId,
      ].filter((id): id is string => id !== null);

      if (eventLocationIds.length > 0 && event.types.length > 0) {
        const subscriptions = await context.prisma.userAlertSubscriptions.findMany({
          where: {
            active: true,
            alertType: { in: event.types },
            locationId: { in: eventLocationIds },
          },
        });

        // Create userAlerts entries for each unique subscriber
        const uniqueUserIds = [...new Set(subscriptions.map((s) => s.userId))];
        if (uniqueUserIds.length > 0) {
          await context.prisma.userAlerts.createMany({
            data: uniqueUserIds.map((userId) => ({
              userId,
              alertId: alert.id,
            })),
            skipDuplicates: true,
          });
        }
      }

      return alert;
    },

    updateAlert: async (
      _parent: unknown,
      args: { id: string; input: UpdateAlertInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { id, input } = args;

      const existing = await context.prisma.alerts.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.alerts.update({
        where: { id },
        data: {
          status: input.status ?? undefined,
        },
      });
    },

    deleteAlert: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.alerts.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.alerts.delete({ where: { id: args.id } });
      return true;
    },
  },
  Alert: {
    event: (parent: { eventId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.events.findUnique({ where: { id: parent.eventId } });
    },
    userAlerts: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userAlerts.findMany({ where: { alertId: parent.id } });
    },
  },
  UserAlert: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    alert: (parent: { alertId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alerts.findUnique({ where: { id: parent.alertId } });
    },
  },
};
