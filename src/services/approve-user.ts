/**
 * Shared business logic for approving a pending user. Used by both the
 * `approveUser` GraphQL mutation and the POST handler on
 * `/portal/admin/approve`. The behaviour is identical from either
 * surface so admins get the same outcome regardless of how they
 * approve.
 *
 * Returns the updated user row plus a CRM sync status (sync is
 * best-effort — local role flip is authoritative).
 */

import { GraphQLError } from "graphql";
import type { PrismaClient } from "../generated/prisma/client.js";
import { logActivity } from "../utils/activity-log.js";
import {
  findContactByEmail,
  moveProspectToApproved,
} from "./exponential.js";

export interface ApproveUserResult {
  user: {
    id: string;
    email: string;
    name: string;
    role: string | null;
    isActive: boolean | null;
  };
  crmMoved: boolean;
  crmWarnings: string[];
}

/**
 * Approve a pending user.
 *
 * Throws `GraphQLError` with `BAD_USER_INPUT` when the user is not
 * currently pending — idempotency safeguard so the same admin double-
 * click doesn't repeatedly hit the CRM. Throws `NOT_FOUND` when the
 * user id doesn't resolve.
 *
 * On success returns the updated user + a CRM-sync summary the caller
 * can use to surface a retry affordance.
 */
export async function approveUserById(
  prisma: PrismaClient,
  approvingAdminId: string,
  targetUserId: string,
): Promise<ApproveUserResult> {
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) {
    throw new GraphQLError("User not found", {
      extensions: { code: "NOT_FOUND" },
    });
  }
  if (user.role !== "pending") {
    throw new GraphQLError(
      `User is not pending (current role: ${user.role ?? "unknown"})`,
      { extensions: { code: "BAD_USER_INPUT" } },
    );
  }

  // Local role flip first — authoritative even if Exponential is
  // unreachable, so the user gets access immediately.
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: "viewer" },
  });

  // Resolve the CRM contact by email (no pointer stored on the user
  // row by design). Every CRM failure is non-fatal and surfaced as a
  // warning string on the result so the admin UI can offer a retry
  // without re-approving the user.
  let crmMoved = false;
  const crmWarnings: string[] = [];

  const lookup = await findContactByEmail(user.email);
  if (!lookup.ok) {
    crmWarnings.push(`crm_lookup_failed:${lookup.reason}`);
  } else if (!lookup.value) {
    crmWarnings.push("crm_contact_not_found");
  } else {
    const moved = await moveProspectToApproved(lookup.value.id);
    if (!moved.ok) {
      crmWarnings.push(`crm_move_failed:${moved.reason}`);
    } else {
      crmMoved = true;
      crmWarnings.push(...moved.value.warnings);
    }
  }

  await logActivity(prisma, {
    userId: approvingAdminId,
    action: "user.approved",
    resourceType: "user",
    resourceId: updated.id,
    metadata: {
      email: user.email,
      crmMoved,
      crmWarnings,
    },
  });

  return {
    user: {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      isActive: updated.isActive,
    },
    crmMoved,
    crmWarnings,
  };
}
