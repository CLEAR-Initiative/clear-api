import type { Context } from "../context.js";

export const exampleResolvers = {
  Query: {
    hello: (_parent: unknown, _args: unknown, _context: Context): string => {
      return "Hello from Apollo Server 5!";
    },
  },
};
