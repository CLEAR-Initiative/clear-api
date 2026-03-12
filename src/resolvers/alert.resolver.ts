import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { AlertStatus } from "../generated/prisma/client.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateAlertInput {
  eventId: string;
  locationIds?: string[];
  metadata?: Record<string, unknown>;
}

interface UpdateAlertInput {
  description?: string;
  severity?: number;
  status?: AlertStatus;
  eventType?: string;
  rank?: number;
  primarySignalId?: string;
  signalIds?: string[];
  locationIds?: string[];
  metadata?: Record<string, unknown>;
}

// Alerts are events with isAlert=true
const ALERT_FILTER = { isAlert: true };

export const alertResolvers = {
  Query: {
    alerts: (_parent: unknown, args: { status?: AlertStatus }, { prisma }: Context) => {
      return prisma.event.findMany({
        where: { ...ALERT_FILTER, ...(args.status ? { status: args.status } : {}) },
      });
    },
    alert: async (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      const event = await prisma.event.findUnique({ where: { id: args.id } });
      if (!event?.isAlert) return null;
      return event;
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

      // Verify the event exists and is not already an alert
      const event = await context.prisma.event.findUnique({
        where: { id: input.eventId },
      });
      if (!event) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (event.isAlert) {
        throw new GraphQLError("Event is already an alert", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Toggle isAlert on the event
      const alert = await context.prisma.event.update({
        where: { id: input.eventId },
        data: {
          isAlert: true,
          metadata: input.metadata ? (input.metadata as InputJsonValue) : undefined,
        },
      });

      // Link locations if provided
      if (input.locationIds?.length) {
        await context.prisma.alertLocation.createMany({
          data: input.locationIds.map((locationId) => ({
            alertId: alert.id,
            locationId,
          })),
        });
      }

      // Gather all location IDs associated with this alert
      const alertLocationIds = input.locationIds ?? [];
      const existingAlertLocations = await context.prisma.alertLocation.findMany({
        where: { alertId: alert.id },
        select: { locationId: true },
      });
      const allLocationIds = [
        ...new Set([
          ...alertLocationIds,
          ...existingAlertLocations.map((al) => al.locationId),
        ]),
      ];

      // Find subscribers matching the alert's eventType and locations
      if (allLocationIds.length > 0) {
        const subscriptions = await context.prisma.userAlertSubscription.findMany({
          where: {
            active: true,
            alertType: event.eventType,
            locationId: { in: allLocationIds },
          },
        });

        // Create userAlert entries for each unique subscriber
        const uniqueUserIds = [...new Set(subscriptions.map((s) => s.userId))];
        if (uniqueUserIds.length > 0) {
          await context.prisma.userAlert.createMany({
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

      const existing = await context.prisma.event.findUnique({ where: { id } });
      if (!existing?.isAlert) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      if (input.signalIds !== undefined) {
        await context.prisma.event.update({
          where: { id },
          data: { signals: { set: input.signalIds.map((sid) => ({ id: sid })) } },
        });
      }

      if (input.locationIds !== undefined) {
        await context.prisma.alertLocation.deleteMany({ where: { alertId: id } });
        if (input.locationIds.length) {
          await context.prisma.alertLocation.createMany({
            data: input.locationIds.map((locationId) => ({
              alertId: id,
              locationId,
            })),
          });
        }
      }

      return context.prisma.event.update({
        where: { id },
        data: {
          description: input.description ?? undefined,
          severity: input.severity ?? undefined,
          status: input.status ?? undefined,
          eventType: input.eventType ?? undefined,
          rank: input.rank ?? undefined,
          primarySignalId: input.primarySignalId,
          metadata: input.metadata as InputJsonValue | undefined,
        },
      });
    },

    deleteAlert: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.event.findUnique({
        where: { id: args.id },
      });
      if (!existing?.isAlert) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.event.delete({ where: { id: args.id } });
      return true;
    },
  },
  Alert: {
    primarySignal: (
      parent: { primarySignalId: string | null },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (!parent.primarySignalId) return null;
      return prisma.signal.findUnique({ where: { id: parent.primarySignalId } });
    },
    signals: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.event
        .findUnique({ where: { id: parent.id } })
        .signals();
    },
    locations: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alertLocation.findMany({ where: { alertId: parent.id } });
    },
    feedback: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userAlert.findMany({ where: { alertId: parent.id } });
    },
  },
  UserAlert: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    alert: (parent: { alertId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.event.findUnique({ where: { id: parent.alertId } });
    },
  },
};
