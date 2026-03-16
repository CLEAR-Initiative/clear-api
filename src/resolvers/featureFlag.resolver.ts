import type { Context } from "../context.js";

export const featureFlagResolvers = {
  Query: {
    featureFlags: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.featureFlags.findMany();
    },
    featureFlag: (_parent: unknown, args: { key: string }, { prisma }: Context) => {
      return prisma.featureFlags.findUnique({ where: { key: args.key } });
    },
  },
};
