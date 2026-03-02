import type { Context } from "../context.js";

export const locationResolvers = {
  Query: {
    locations: (_parent: unknown, args: { level?: number }, { prisma }: Context) => {
      return prisma.location.findMany({
        where: args.level !== undefined ? { level: args.level } : undefined,
      });
    },
    location: (_parent: unknown, args: { id: number }, { prisma }: Context) => {
      return prisma.location.findUnique({ where: { id: args.id } });
    },
  },
  Location: {
    parent: (parent: { parentId: number | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.parentId) return null;
      return prisma.location.findUnique({ where: { id: parent.parentId } });
    },
    children: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.location.findMany({ where: { parentId: parent.id } });
    },
    alertLinks: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.alertLocation.findMany({ where: { locationId: parent.id } });
    },
    detectionLinks: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.detectionLocation.findMany({ where: { locationId: parent.id } });
    },
  },
  AlertLocation: {
    alert: (parent: { alertId: number }, _args: unknown, { prisma }: Context) => {
      return prisma.alert.findUnique({ where: { id: parent.alertId } });
    },
    location: (parent: { locationId: number }, _args: unknown, { prisma }: Context) => {
      return prisma.location.findUnique({ where: { id: parent.locationId } });
    },
  },
  DetectionLocation: {
    detection: (parent: { detectionId: number }, _args: unknown, { prisma }: Context) => {
      return prisma.detection.findUnique({ where: { id: parent.detectionId } });
    },
    location: (parent: { locationId: number }, _args: unknown, { prisma }: Context) => {
      return prisma.location.findUnique({ where: { id: parent.locationId } });
    },
  },
};
