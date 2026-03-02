import type { Context } from "../context.js";

export const userResolvers = {
  Query: {
    users: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.user.findMany();
    },
    user: (_parent: unknown, args: { id: number }, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: args.id } });
    },
  },
  User: {
    accounts: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.account.findMany({ where: { userId: parent.id } });
    },
    sessions: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.session.findMany({ where: { userId: parent.id } });
    },
    createdAlerts: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.alert.findMany({ where: { createdById: parent.id } });
    },
    feedback: (parent: { id: number }, _args: unknown, { prisma }: Context) => {
      return prisma.userAlert.findMany({ where: { userId: parent.id } });
    },
  },
  Account: {
    user: (parent: { userId: number }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
  },
  Session: {
    user: (parent: { userId: number }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
  },
};
