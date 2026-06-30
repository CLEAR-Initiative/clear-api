import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";

export const featureFlagResolvers = {
  Query: {
    featureFlags: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.featureFlags.findMany();
    },
    featureFlag: (_parent: unknown, args: { key: string }, { prisma }: Context) => {
      return prisma.featureFlags.findUnique({ where: { key: args.key } });
    },
  },
  Mutation: {
    setFeatureFlag: async (
      _parent: unknown,
      args: { key: string; enabled: boolean },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      // Upsert keyed by the unique `key` column. We pass `enabled` for both
      // create and update so the result is identical regardless of which
      // branch fires — the caller sees the post-write state either way.
      return context.prisma.featureFlags.upsert({
        where: { key: args.key },
        create: { key: args.key, enabled: args.enabled },
        update: { enabled: args.enabled },
      });
    },
  },
};
