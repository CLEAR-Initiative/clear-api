import type { Context } from "../context.js";

export const userResolvers = {
  Query: {
    users: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.user.findMany();
    },
    user: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: args.id } });
    },
  },
  User: {
    createdAlerts: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alert.findMany({ where: { createdById: parent.id } });
    },
    feedback: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userAlert.findMany({ where: { userId: parent.id } });
    },
  },
};
