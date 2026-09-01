/**
 * Shared business logic for changing a user's global platform role.
 * Used by the `updateUserRole` GraphQL mutation and the POST handler
 * on `/portal/admin/users/role` so both surfaces apply the same
 * guards (pending, self-demote, last admin).
 */

import { GraphQLError } from "graphql";
import type { PrismaClient } from "../generated/prisma/client.js";
import { logActivity } from "../utils/activity-log.js";

export const GLOBAL_ROLES = ["viewer", "analyst", "admin"] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export function isGlobalRole(role: string): role is GlobalRole {
  return (GLOBAL_ROLES as readonly string[]).includes(role);
}

export async function updateUserGlobalRole(
  prisma: PrismaClient,
  actingAdminId: string,
  targetUserId: string,
  role: string,
) {
  if (!targetUserId || !role) {
    throw new GraphQLError("Missing fields.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (!isGlobalRole(role)) {
    throw new GraphQLError(
      `Invalid role "${role}". Must be viewer, analyst, or admin.`,
      { extensions: { code: "BAD_USER_INPUT" } },
    );
  }
  if (targetUserId === actingAdminId && role !== "admin") {
    throw new GraphQLError("You cannot change your own role.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }

  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) {
    throw new GraphQLError("User not found.", {
      extensions: { code: "NOT_FOUND" },
    });
  }
  if (target.role === "pending") {
    throw new GraphQLError("Approve pending users first.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (target.role === "admin" && role !== "admin") {
    const adminCount = await prisma.user.count({ where: { role: "admin" } });
    if (adminCount <= 1) {
      throw new GraphQLError("Cannot demote the last admin.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
  }

  if (target.role === role) return target;

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { role },
  });

  await logActivity(prisma, {
    userId: actingAdminId,
    action: "user.role_updated",
    resourceType: "user",
    resourceId: updated.id,
    metadata: {
      email: target.email,
      from: target.role,
      to: role,
    },
  });

  return updated;
}
