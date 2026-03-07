import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";

export const signalResolvers = {
  Query: {
    signals: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.signal.findMany();
    },
    signal: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.signal.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createSignal: async (
      _parent: unknown,
      args: { detectionId: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);

      const detection = await context.prisma.detection.findUnique({
        where: { id: args.detectionId },
      });
      if (!detection) {
        throw new GraphQLError("Detection not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const existing = await context.prisma.signal.findUnique({
        where: { detectionId: args.detectionId },
      });
      if (existing) {
        throw new GraphQLError("A signal already exists for this detection", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      return context.prisma.signal.create({
        data: { detectionId: args.detectionId },
      });
    },

    deleteSignal: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.signal.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Signal not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.signal.delete({ where: { id: args.id } });
      return true;
    },
  },
  Signal: {
    detection: (parent: { detectionId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.detection.findUnique({ where: { id: parent.detectionId } });
    },
    events: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.signal
        .findUnique({ where: { id: parent.id } })
        .events();
    },
    primaryOf: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.event.findMany({ where: { primarySignalId: parent.id } });
    },
  },
};
