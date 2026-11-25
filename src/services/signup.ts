/**
 * Side effects of a Developer Portal self-signup, run from Better Auth's
 * `user.create.after` hook (src/lib/auth.ts):
 *
 *   1. CLEAR-branded acknowledgement email to the registrant.
 *   2. CRM contact into Exponential prospects (approval later moves them
 *      to the approved collection).
 *   3. "New developer sign-up" email to the CLEAR maintainers
 *      (`SIGNUP_NOTIFY_EMAILS`).
 *
 * All three are best-effort: if any of them fails, signup still succeeds.
 * Each helper swallows its own errors; `allSettled` is the backstop in
 * case one throws anyway. A CRM failure is also written to the activity
 * log (`user.crm_sync_failed`) so it can be seen and repaired by the CRM
 * sync (services/crm-sync.ts) instead of vanishing into stderr.
 */

import { prisma } from "../lib/prisma.js";
import { logActivity } from "../utils/activity-log.js";
import { pushToProspects } from "./exponential.js";
import { sendSignupAcknowledgement } from "./signup-ack.js";
import { notifyMaintainersOfSignup } from "./signup-notify.js";

/**
 * Split a Better Auth display name into first / last so the CRM contact
 * row gets populated as expected. Best-effort — accounts created with a
 * single-word name land it in `firstName` with `lastName` left null.
 */
export function splitName(name: string | null | undefined): {
  firstName: string | undefined;
  lastName: string | undefined;
} {
  if (!name) return { firstName: undefined, lastName: undefined };
  const trimmed = name.trim();
  if (!trimmed) return { firstName: undefined, lastName: undefined };
  const space = trimmed.indexOf(" ");
  if (space === -1) return { firstName: trimmed, lastName: undefined };
  return {
    firstName: trimmed.slice(0, space),
    lastName: trimmed.slice(space + 1).trim() || undefined,
  };
}

export async function onDeveloperSignedUp(user: {
  id: string;
  name: string | null | undefined;
  email: string;
}): Promise<void> {
  const { firstName, lastName } = splitName(user.name);
  const [crm, ack, notify] = await Promise.allSettled([
    pushToProspects({ email: user.email, firstName, lastName }),
    sendSignupAcknowledgement({ email: user.email, name: firstName ?? user.name }),
    notifyMaintainersOfSignup({ name: user.name, email: user.email }),
  ]);

  // An unconfigured CRM is a valid setup, not a failure.
  const crmFailure =
    crm.status === "rejected"
      ? `threw:${crm.reason instanceof Error ? crm.reason.message : String(crm.reason)}`
      : !crm.value.ok && crm.value.reason !== "not_configured"
        ? crm.value.reason
        : null;
  if (crmFailure) {
    console.error(`[auth.signup] CRM prospects sync failed for ${user.email}: ${crmFailure}`);
    await logActivity(prisma, {
      userId: user.id,
      action: "user.crm_sync_failed",
      resourceType: "user",
      resourceId: user.id,
      metadata: { email: user.email, stage: "signup", reason: crmFailure },
    });
  }
  if (ack.status === "rejected") {
    console.error(`[auth.signup] acknowledgement threw for ${user.email}:`, ack.reason);
  }
  if (notify.status === "rejected") {
    console.error(`[auth.signup] maintainer notification threw for ${user.email}:`, notify.reason);
  }
}
