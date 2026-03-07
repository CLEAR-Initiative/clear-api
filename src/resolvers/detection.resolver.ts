import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { DetectionStatus } from "../generated/prisma/client.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateDetectionInput {
  title: string;
  confidence?: number;
  status?: DetectionStatus;
  detectedAt?: string;
  rawData?: Record<string, unknown>;
  sourceId?: string;
  locationIds?: string[];
}

interface UpdateDetectionInput {
  title?: string;
  confidence?: number;
  status?: DetectionStatus;
  rawData?: Record<string, unknown>;
  sourceId?: string;
  locationIds?: string[];
}

export const detectionResolvers = {
  Query: {
    detections: (
      _parent: unknown,
      args: { status?: DetectionStatus },
      { prisma }: Context,
    ) => {
      return prisma.detection.findMany({
        where: args.status ? { status: args.status } : undefined,
      });
    },
    detection: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.detection.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createDetection: async (
      _parent: unknown,
      args: { input: CreateDetectionInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      const detection = await context.prisma.detection.create({
        data: {
          title: input.title,
          confidence: input.confidence,
          status: input.status ?? "raw",
          detectedAt: input.detectedAt ? new Date(input.detectedAt) : undefined,
          rawData: input.rawData ? (input.rawData as InputJsonValue) : undefined,
          sourceId: input.sourceId,
        },
      });

      if (input.locationIds?.length) {
        await context.prisma.detectionLocation.createMany({
          data: input.locationIds.map((locationId) => ({
            detectionId: detection.id,
            locationId,
          })),
        });
      }

      return detection;
    },

    updateDetection: async (
      _parent: unknown,
      args: { id: string; input: UpdateDetectionInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { id, input } = args;

      const existing = await context.prisma.detection.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Detection not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      if (input.locationIds !== undefined) {
        await context.prisma.detectionLocation.deleteMany({ where: { detectionId: id } });
        if (input.locationIds.length) {
          await context.prisma.detectionLocation.createMany({
            data: input.locationIds.map((locationId) => ({
              detectionId: id,
              locationId,
            })),
          });
        }
      }

      return context.prisma.detection.update({
        where: { id },
        data: {
          title: input.title ?? undefined,
          confidence: input.confidence ?? undefined,
          status: input.status ?? undefined,
          rawData: input.rawData as InputJsonValue | undefined,
          sourceId: input.sourceId,
        },
      });
    },

    deleteDetection: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.detection.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Detection not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.detection.delete({ where: { id: args.id } });
      return true;
    },
  },
  Detection: {
    source: (parent: { sourceId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.sourceId) return null;
      return prisma.dataSource.findUnique({ where: { id: parent.sourceId } });
    },
    signal: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.signal.findUnique({ where: { detectionId: parent.id } });
    },
    locations: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.detectionLocation.findMany({ where: { detectionId: parent.id } });
    },
  },
};
