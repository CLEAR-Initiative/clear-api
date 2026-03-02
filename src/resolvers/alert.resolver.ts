import type { Context } from "../context.js";
import type { AlertStatus } from "../generated/prisma/client.js";

export const alertResolvers = {
  Query: {
    alerts: (_parent: unknown, args: { status?: AlertStatus }, { prisma }: Context) => {
      return prisma.alert.findMany({
        where: args.status ? { status: args.status } : undefined,
      });
    },
    alert: (_parent: unknown, args: { id: number }, { prisma }: Context) => {
      return prisma.alert.findUnique({ where: { id: args.id } });
    },
  },
  Alert: {
    source: (parent: { sourceId: number | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.sourceId) return null;
      return prisma.dataSource.findUnique({ where: { id: parent.sourceId } });
    },
    createdBy: (parent: { createdById: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.createdById) return null;
      return prisma.user.findUnique({ where: { id: parent.createdById } });
    },
    primaryDetection: (
      parent: { primaryDetectionId: number | null },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (!parent.primaryDetectionId) return null;
      return prisma.detection.findUnique({ where: { id: parent.primaryDetectionId } });
    },
    detections: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.detection.findMany({ where: { alertId: parent.id } });
    },
    locations: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.alertLocation.findMany({ where: { alertId: parent.id } });
    },
    feedback: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.userAlert.findMany({ where: { alertId: parent.id } });
    },
  },
  UserAlert: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    alert: (parent: { alertId: number }, _args: unknown, { prisma }: Context) => {
      return prisma.alert.findUnique({ where: { id: parent.alertId } });
    },
  },
};
