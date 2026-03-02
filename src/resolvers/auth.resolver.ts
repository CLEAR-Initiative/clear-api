import type { Context } from "../context.js";

export const authResolvers = {
  Query: {
    me: (_parent: unknown, _args: unknown, { user }: Context) => {
      if (!user) return null;
      return user;
    },
  },
};
