import type { Context } from "../context.js";

export const featureFlagResolvers = {
  Query: {
    featureFlags: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.featureFlag.findMany();
    },
    featureFlag: (_parent: unknown, args: { key: string }, { prisma }: Context) => {
      return prisma.featureFlag.findUnique({ where: { key: args.key } });
    },
  },
};
