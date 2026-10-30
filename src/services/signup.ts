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
 * case one throws anyway.
 */

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
  name: string | null | undefined;
  email: string;
}): Promise<void> {
  const { firstName, lastName } = splitName(user.name);
  const [crm, ack, notify] = await Promise.allSettled([
    pushToProspects({ email: user.email, firstName, lastName }),
    sendSignupAcknowledgement({ email: user.email, name: firstName ?? user.name }),
    notifyMaintainersOfSignup({ name: user.name, email: user.email }),
  ]);

  if (crm.status === "rejected") {
    console.error(`[auth.signup] CRM prospects sync threw for ${user.email}:`, crm.reason);
  } else if (!crm.value.ok) {
    console.error(
      `[auth.signup] CRM prospects sync failed for ${user.email}: ${crm.value.reason}`,
    );
  }
  if (ack.status === "rejected") {
    console.error(`[auth.signup] acknowledgement threw for ${user.email}:`, ack.reason);
  }
  if (notify.status === "rejected") {
    console.error(`[auth.signup] maintainer notification threw for ${user.email}:`, notify.reason);
  }
}
