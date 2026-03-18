import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateSignalInput {
  sourceId: string;
  rawData: Record<string, unknown>;
  publishedAt: string;
  collectedAt?: string;
  url?: string;
  title?: string;
  description?: string;
  originId?: string;
  destinationId?: string;
  locationId?: string;
}

export const signalResolvers = {
  Query: {
    signals: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.signals.findMany();
    },
    signal: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.signals.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createSignal: async (
      _parent: unknown,
      args: { input: CreateSignalInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      const dataSource = await context.prisma.dataSources.findUnique({
        where: { id: input.sourceId },
      });
      if (!dataSource) {
        throw new GraphQLError("DataSource not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.signals.create({
        data: {
          sourceId: input.sourceId,
          rawData: input.rawData as InputJsonValue,
          publishedAt: new Date(input.publishedAt),
          collectedAt: input.collectedAt ? new Date(input.collectedAt) : new Date(),
          url: input.url,
          title: input.title,
          description: input.description,
          originId: input.originId,
          destinationId: input.destinationId,
          locationId: input.locationId,
        },
      });
    },

    deleteSignal: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.signals.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Signal not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.signals.delete({ where: { id: args.id } });
      return true;
    },
  },
  Signal: {
    source: (parent: { sourceId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.dataSources.findUnique({ where: { id: parent.sourceId } });
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
    events: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.signalEvents.findMany({
        where: { signalId: parent.id },
        include: { event: true },
      }).then((links) => links.map((l) => l.event));
    },
    feedbacks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userFeedbacks.findMany({ where: { signalId: parent.id } });
    },
    comments: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userComments.findMany({ where: { signalId: parent.id } });
    },
  },
};
