import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateEventInput {
  signalIds: string[];
  primarySignalId?: string;
  eventType: string;
  rank: number;
  severity: number;
  description?: string;
  firstSignalCreatedAt: string;
  lastSignalCreatedAt: string;
}

interface UpdateEventInput {
  signalIds?: string[];
  primarySignalId?: string;
  eventType?: string;
  rank?: number;
  severity?: number;
  description?: string;
}

export const eventResolvers = {
  Query: {
    events: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.event.findMany({
        where: { isAlert: false },
      });
    },
    event: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.event.findUnique({ where: { id: args.id } });
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

      return context.prisma.event.create({
        data: {
          primarySignalId: input.primarySignalId,
          eventType: input.eventType,
          rank: input.rank,
          severity: input.severity,
          description: input.description,
          firstSignalCreatedAt: new Date(input.firstSignalCreatedAt),
          lastSignalCreatedAt: new Date(input.lastSignalCreatedAt),
          signals: {
            connect: input.signalIds.map((id) => ({ id })),
          },
        },
      });
    },

    updateEvent: async (
      _parent: unknown,
      args: { id: string; input: UpdateEventInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { id, input } = args;

      const existing = await context.prisma.event.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.event.update({
        where: { id },
        data: {
          primarySignalId: input.primarySignalId,
          eventType: input.eventType ?? undefined,
          rank: input.rank ?? undefined,
          severity: input.severity ?? undefined,
          description: input.description ?? undefined,
          signals: input.signalIds
            ? { set: input.signalIds.map((sid) => ({ id: sid })) }
            : undefined,
        },
      });
    },

    deleteEvent: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.event.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.event.delete({ where: { id: args.id } });
      return true;
    },
  },
  Event: {
    signals: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.event
        .findUnique({ where: { id: parent.id } })
        .signals();
    },
    primarySignal: (parent: { primarySignalId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.primarySignalId) return null;
      return prisma.signal.findUnique({ where: { id: parent.primarySignalId } });
    },
    locations: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alertLocation.findMany({ where: { alertId: parent.id } });
    },
    feedback: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userAlert.findMany({ where: { alertId: parent.id } });
    },
  },
};
