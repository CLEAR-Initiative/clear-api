import type { Context } from "../context.js";
import type { DetectionStatus } from "../generated/prisma/client.js";

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
    detection: (_parent: unknown, args: { id: number }, { prisma }: Context) => {
      return prisma.detection.findUnique({ where: { id: args.id } });
    },
  },
  Detection: {
    source: (parent: { sourceId: number | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.sourceId) return null;
      return prisma.dataSource.findUnique({ where: { id: parent.sourceId } });
    },
    alert: (parent: { alertId: number | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.alertId) return null;
      return prisma.alert.findUnique({ where: { id: parent.alertId } });
    },
    locations: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.detectionLocation.findMany({ where: { detectionId: parent.id } });
    },
  },
};
