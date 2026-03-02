import { GraphQLError } from "graphql";
import type { Context } from "../context.js";

export function requireAuth(context: Context) {
  if (!context.user) {
    throw new GraphQLError("You must be logged in", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return context.user;
}

export function requireRole(context: Context, roles: string[]) {
  const user = requireAuth(context);
  if (!user.role || !roles.includes(user.role)) {
    throw new GraphQLError("Insufficient permissions", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return user;
}
