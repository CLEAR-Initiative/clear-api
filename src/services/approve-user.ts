/**
 * Shared business logic for approving a pending user. Used by both the
 * `approveUser` GraphQL mutation and the POST handler on
 * `/portal/admin/approve`. The behaviour is identical from either
 * surface so admins get the same outcome regardless of how they
 * approve.
 *
 * Returns the updated user row plus the outcome of the two side
 * effects: the approval email and the CRM mirror. Both are best-effort —
 * the local role flip is authoritative and neither can undo it. The CRM
 * is optional: with no EXPONENTIAL_* config it is skipped silently.
 */

import { GraphQLError } from "graphql";
import type { PrismaClient } from "../generated/prisma/client.js";
import { logActivity } from "../utils/activity-log.js";
import { sendApprovalEmail } from "./approval-email.js";
import { syncApprovedContact } from "./exponential.js";
import { splitName } from "./signup.js";

export interface ApproveUserResult {
  user: {
    id: string;
    email: string;
    name: string;
    role: string | null;
    isActive: boolean | null;
  };
  /** False when the email provider threw or rejected the send. */
  emailSent: boolean;
  /** Why the email failed; null when it was sent. */
  emailError: string | null;
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
 * On success returns the updated user + email and CRM-sync summaries
 * the caller surfaces to the admin.
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

  // Local role flip first — authoritative even if the mail provider or CRM
  // is unreachable, so the user gets access immediately. `member` is the
  // default approved human role (formerly `viewer`). Conditional on
  // `pending` so that of two overlapping approvals only one wins the flip
  // and goes on to email the user.
  const flipped = await prisma.user.updateMany({
    where: { id: user.id, role: "pending" },
    data: { role: "member" },
  });
  if (flipped.count === 0) {
    throw new GraphQLError("User is not pending (already approved)", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  const updated = { ...user, role: "member" };

  // Independent side effects; neither throws.
  const [email, synced] = await Promise.all([
    sendApprovalEmail({ email: user.email, name: user.name }),
    syncApprovedContact({ email: user.email, ...splitName(user.name) }),
  ]);
  const emailSent = email.ok;
  const emailError = email.ok ? null : email.reason;

  // CRM mirror. Every failure is non-fatal and surfaced as a warning
  // string so the admin sees it; an unconfigured CRM is not a failure.
  let crmMoved = false;
  const crmWarnings: string[] = [];
  if (synced.ok) {
    crmMoved = true;
    crmWarnings.push(...synced.value.warnings);
  } else if (synced.reason !== "not_configured") {
    crmWarnings.push(`crm_sync_failed:${synced.reason}`);
  }

  await logActivity(prisma, {
    userId: approvingAdminId,
    action: "user.approved",
    resourceType: "user",
    resourceId: updated.id,
    metadata: {
      email: user.email,
      emailSent,
      emailError,
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
    emailSent,
    emailError,
    crmMoved,
    crmWarnings,
  };
}

/** One-line outcome for the admin portal's flash message. */
export function approvalSummary(result: ApproveUserResult): string {
  const parts = [
    result.emailSent
      ? "Approved. Approval email sent."
      : `Approved, but the approval email failed (${result.emailError}). Let them know another way.`,
  ];
  if (result.crmWarnings.length > 0) {
    parts.push(`CRM sync issues: ${result.crmWarnings.join(", ")}`);
  }
  return parts.join(" ");
}
