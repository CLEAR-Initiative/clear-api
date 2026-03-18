import type { Context } from "../context.js";

export const disasterTypeResolvers = {
  Query: {
    disasterTypes: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.disasterTypes.findMany();
    },
    disasterType: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.disasterTypes.findUnique({ where: { id: args.id } });
    },
  },
};
