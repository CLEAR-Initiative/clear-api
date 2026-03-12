import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { DetectionStatus } from "../generated/prisma/client.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateSourceInput {
  title: string;
  confidence?: number;
  status?: DetectionStatus;
  detectedAt?: string;
  rawData?: Record<string, unknown>;
  dataSourceId?: string;
  locationIds?: string[];
}

interface UpdateSourceInput {
  title?: string;
  confidence?: number;
  status?: DetectionStatus;
  rawData?: Record<string, unknown>;
  dataSourceId?: string;
  locationIds?: string[];
}

export const detectionResolvers = {
  Query: {
    detections: (
      _parent: unknown,
      args: { status?: DetectionStatus },
      { prisma }: Context,
    ) => {
      return prisma.source.findMany({
        where: args.status ? { status: args.status } : undefined,
      });
    },
    detection: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.source.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createDetection: async (
      _parent: unknown,
      args: { input: CreateSourceInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      const source = await context.prisma.source.create({
        data: {
          title: input.title,
          confidence: input.confidence,
          status: input.status ?? "raw",
          detectedAt: input.detectedAt ? new Date(input.detectedAt) : undefined,
          rawData: input.rawData ? (input.rawData as InputJsonValue) : undefined,
          dataSourceId: input.dataSourceId,
        },
      });

      if (input.locationIds?.length) {
        await context.prisma.sourceLocation.createMany({
          data: input.locationIds.map((locationId) => ({
            sourceId: source.id,
            locationId,
          })),
        });
      }

      return source;
    },

    updateDetection: async (
      _parent: unknown,
      args: { id: string; input: UpdateSourceInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { id, input } = args;

      const existing = await context.prisma.source.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Detection not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      if (input.locationIds !== undefined) {
        await context.prisma.sourceLocation.deleteMany({ where: { sourceId: id } });
        if (input.locationIds.length) {
          await context.prisma.sourceLocation.createMany({
            data: input.locationIds.map((locationId) => ({
              sourceId: id,
              locationId,
            })),
          });
        }
      }

      return context.prisma.source.update({
        where: { id },
        data: {
          title: input.title ?? undefined,
          confidence: input.confidence ?? undefined,
          status: input.status ?? undefined,
          rawData: input.rawData as InputJsonValue | undefined,
          dataSourceId: input.dataSourceId,
        },
      });
    },

    deleteDetection: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.source.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Detection not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.source.delete({ where: { id: args.id } });
      return true;
    },
  },
  Detection: {
    source: (parent: { dataSourceId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.dataSourceId) return null;
      return prisma.dataSource.findUnique({ where: { id: parent.dataSourceId } });
    },
    signal: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.signal.findUnique({ where: { sourceId: parent.id } });
    },
    locations: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.sourceLocation.findMany({ where: { sourceId: parent.id } });
    },
  },
};
