/**
 * Tells CLEAR maintainers about new Developer Portal sign-ups.
 *
 * Recipients come from `SIGNUP_NOTIFY_EMAILS`; when it is empty nothing
 * is sent. Two moments trigger a mail:
 *
 *   - the account is created (Better Auth's `user.create.after` hook)
 *   - the Developer submits the Welcome page form for the first time
 *
 * Best-effort, like the signup acknowledgement: every failure is logged
 * and swallowed, so neither sign-up nor the Welcome form can fail on a
 * dead mail provider.
 */

import { env } from "../utils/env.js";
import { getEmailProvider, templates } from "./messaging/index.js";
import type {
  DeveloperProfileDetails,
  EmailContent,
} from "./messaging/templates.js";

/** Where maintainers approve pending sign-ups. */
export function adminUsersUrl(): string {
  return `${env.BETTER_AUTH_URL}/portal/admin?tab=users`;
}

async function sendToMaintainers(
  content: EmailContent,
  context: string,
): Promise<void> {
  const recipients = env.SIGNUP_NOTIFY_EMAILS;
  if (recipients.length === 0) {
    console.log(
      `[signup-notify] SIGNUP_NOTIFY_EMAILS is empty; not sending "${content.subject}"`,
    );
    return;
  }

  try {
    const provider = await getEmailProvider();
    // One message per recipient so maintainers don't see each other's
    // addresses and one bad address can't sink the rest.
    const results = await Promise.allSettled(
      recipients.map((to) =>
        provider.send({
          to,
          subject: content.subject,
          textBody: content.textBody,
          htmlBody: content.htmlBody,
        }),
      ),
    );
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(
          `[signup-notify] ${context} email to ${recipients[i]} failed:`,
          r.reason instanceof Error ? r.reason.message : r.reason,
        );
      }
    });
  } catch (error) {
    console.error(
      `[signup-notify] ${context} email failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** "New developer sign-up: {name} <{email}>", sent from the signup hook. */
export async function notifyMaintainersOfSignup(user: {
  name: string | null | undefined;
  email: string;
}): Promise<void> {
  await sendToMaintainers(
    templates.maintainerSignupNotification(user.name ?? "", user.email, adminUsersUrl()),
    "sign-up",
  );
}

/** Sent once, on the Developer's first Welcome page submission. */
export async function notifyMaintainersOfProfile(
  user: { name: string; email: string },
  profile: DeveloperProfileDetails,
): Promise<void> {
  await sendToMaintainers(
    templates.maintainerProfileNotification(user.name, user.email, profile, adminUsersUrl()),
    "profile",
  );
}
