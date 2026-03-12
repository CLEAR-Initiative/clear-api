import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { AlertStatus } from "../generated/prisma/client.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateAlertInput {
  description: string;
  severity: number;
  status?: AlertStatus;
  eventType: string;
  rank: number;
  primarySignalId?: string;
  signalIds?: string[];
  locationIds?: string[];
  metadata?: Record<string, unknown>;
  firstSignalCreatedAt: string;
  lastSignalCreatedAt: string;
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

      const alert = await context.prisma.event.create({
        data: {
          isAlert: true,
          description: input.description,
          severity: input.severity,
          status: input.status ?? "draft",
          eventType: input.eventType,
          rank: input.rank,
          firstSignalCreatedAt: new Date(input.firstSignalCreatedAt),
          lastSignalCreatedAt: new Date(input.lastSignalCreatedAt),
          primarySignalId: input.primarySignalId,
          metadata: input.metadata ? (input.metadata as InputJsonValue) : undefined,
          signals: input.signalIds?.length
            ? { connect: input.signalIds.map((id) => ({ id })) }
            : undefined,
        },
      });

      if (input.locationIds?.length) {
        await context.prisma.alertLocation.createMany({
          data: input.locationIds.map((locationId) => ({
            alertId: alert.id,
            locationId,
          })),
        });
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
