import type { Context } from "../context.js";

export const dataSourceResolvers = {
  Query: {
    dataSources: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.dataSource.findMany();
    },
    dataSource: (_parent: unknown, args: { id: number }, { prisma }: Context) => {
      return prisma.dataSource.findUnique({ where: { id: args.id } });
    },
  },
  DataSource: {
    detections: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.detection.findMany({ where: { sourceId: parent.id } });
    },
    alerts: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.alert.findMany({ where: { sourceId: parent.id } });
    },
  },
};
