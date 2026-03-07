import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateLocationInput {
  geoId: string;
  name: string;
  level: number;
  pointType?: string;
  parentId?: string;
}

interface UpdateLocationInput {
  geoId?: string;
  name?: string;
  level?: number;
  pointType?: string;
  parentId?: string;
}

export const locationResolvers = {
  Query: {
    locations: (_parent: unknown, args: { level?: number }, { prisma }: Context) => {
      return prisma.location.findMany({
        where: args.level !== undefined ? { level: args.level } : undefined,
      });
    },
    location: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.location.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createLocation: async (
      _parent: unknown,
      args: { input: CreateLocationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { input } = args;

      return context.prisma.location.create({
        data: {
          geoId: input.geoId,
          name: input.name,
          level: input.level,
          pointType: input.pointType as "CENTROID" | "GPS" | undefined,
          parentId: input.parentId,
        },
      });
    },

    updateLocation: async (
      _parent: unknown,
      args: { id: string; input: UpdateLocationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { id, input } = args;

      const existing = await context.prisma.location.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Location not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.location.update({
        where: { id },
        data: {
          geoId: input.geoId ?? undefined,
          name: input.name ?? undefined,
          level: input.level ?? undefined,
          pointType: input.pointType as "CENTROID" | "GPS" | undefined,
          parentId: input.parentId,
        },
      });
    },

    deleteLocation: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.location.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Location not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.location.delete({ where: { id: args.id } });
      return true;
    },
  },
  Location: {
    parent: (parent: { parentId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.parentId) return null;
      return prisma.location.findUnique({ where: { id: parent.parentId } });
    },
    children: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.location.findMany({ where: { parentId: parent.id } });
    },
    alertLinks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alertLocation.findMany({ where: { locationId: parent.id } });
    },
    detectionLinks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.detectionLocation.findMany({ where: { locationId: parent.id } });
    },
  },
  AlertLocation: {
    alert: (parent: { alertId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alert.findUnique({ where: { id: parent.alertId } });
    },
    location: (parent: { locationId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.location.findUnique({ where: { id: parent.locationId } });
    },
  },
  DetectionLocation: {
    detection: (parent: { detectionId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.detection.findUnique({ where: { id: parent.detectionId } });
    },
    location: (parent: { locationId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.location.findUnique({ where: { id: parent.locationId } });
    },
  },
};
