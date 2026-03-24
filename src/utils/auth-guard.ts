import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { PrismaClient } from "../generated/prisma/client.js";

export function requireAuth(context: Context) {
  if (!context.user) {
    throw new GraphQLError("You must be logged in", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return context.user;
}

/** Check global user.role (admin, viewer). Use for platform-wide operations. */
export function requireRole(context: Context, roles: string[]) {
  const user = requireAuth(context);
  if (!user.role || !roles.includes(user.role)) {
    throw new GraphQLError("Insufficient permissions", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return user;
}

/**
 * Look up the user's role in a team. Returns the teamMembers record.
 * Throws FORBIDDEN if the user is not a member (unless they're a global admin).
 */
export async function resolveTeamMembership(
  prisma: PrismaClient,
  userId: string,
  teamId: string,
  userRole?: string | null,
) {
  // Global admins can access any team's data
  if (userRole === "admin") return null;

  const membership = await prisma.teamMembers.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    throw new GraphQLError("Not a member of this team", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return membership;
}
