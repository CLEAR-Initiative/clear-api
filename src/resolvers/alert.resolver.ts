import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { AlertStatus } from "../generated/prisma/client.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateAlertInput {
  title: string;
  description: string;
  severity: number;
  status?: AlertStatus;
  sourceId?: string;
  primaryEventId?: string;
  eventIds?: string[];
  locationIds?: string[];
  metadata?: Record<string, unknown>;
}

interface UpdateAlertInput {
  title?: string;
  description?: string;
  severity?: number;
  status?: AlertStatus;
  sourceId?: string;
  primaryEventId?: string;
  eventIds?: string[];
  locationIds?: string[];
  metadata?: Record<string, unknown>;
}

export const alertResolvers = {
  Query: {
    alerts: (_parent: unknown, args: { status?: AlertStatus }, { prisma }: Context) => {
      return prisma.alert.findMany({
        where: args.status ? { status: args.status } : undefined,
      });
    },
    alert: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.alert.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createAlert: async (
      _parent: unknown,
      args: { input: CreateAlertInput },
      context: Context,
    ) => {
      const user = requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      const alert = await context.prisma.alert.create({
        data: {
          title: input.title,
          description: input.description,
          severity: input.severity,
          status: input.status ?? "draft",
          sourceId: input.sourceId,
          primaryEventId: input.primaryEventId,
          createdById: user.id,
          metadata: input.metadata ? (input.metadata as InputJsonValue) : undefined,
          events: input.eventIds?.length
            ? { connect: input.eventIds.map((id) => ({ id })) }
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

      const existing = await context.prisma.alert.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      if (input.eventIds !== undefined) {
        await context.prisma.alert.update({
          where: { id },
          data: { events: { set: input.eventIds.map((eid) => ({ id: eid })) } },
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

      return context.prisma.alert.update({
        where: { id },
        data: {
          title: input.title ?? undefined,
          description: input.description ?? undefined,
          severity: input.severity ?? undefined,
          status: input.status ?? undefined,
          sourceId: input.sourceId,
          primaryEventId: input.primaryEventId,
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

      const existing = await context.prisma.alert.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.alert.delete({ where: { id: args.id } });
      return true;
    },
  },
  Alert: {
    source: (parent: { sourceId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.sourceId) return null;
      return prisma.dataSource.findUnique({ where: { id: parent.sourceId } });
    },
    createdBy: (parent: { createdById: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.createdById) return null;
      return prisma.user.findUnique({ where: { id: parent.createdById } });
    },
    primaryEvent: (
      parent: { primaryEventId: string | null },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (!parent.primaryEventId) return null;
      return prisma.event.findUnique({ where: { id: parent.primaryEventId } });
    },
    events: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alert
        .findUnique({ where: { id: parent.id } })
        .events();
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
      return prisma.alert.findUnique({ where: { id: parent.alertId } });
    },
  },
};
