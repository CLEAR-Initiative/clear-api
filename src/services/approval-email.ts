/**
 * "Your account is approved" email, sent by `approveUserById` once the
 * role flip has landed. Sent from this API so approval never depends on a
 * CRM automation — the CRM sync is a separate, optional mirror. Disable
 * any Exponential automation that emails on joining the approved
 * collection, or approved users receive two emails.
 */

import { env } from "../utils/env.js";
import { getEmailProvider, templates } from "./messaging/index.js";

/** Where approval sends the user: the API Keys section that approval
 *  unlocks. `env.BETTER_AUTH_URL` is normalised to a bare origin on load,
 *  so the concatenation can't inherit a stray path. */
export function portalApiKeysUrl(): string {
  return `${env.BETTER_AUTH_URL}/portal#api-keys`;
}

export type ApprovalEmailResult = { ok: true } | { ok: false; reason: string };

/** The admin's approval reply waits on this send, so a stalled provider
 *  must not hold it open: past this deadline the send is reported as
 *  failed. A late delivery is still possible; the admin is told to check. */
export const APPROVAL_EMAIL_TIMEOUT_MS = 10_000;

/**
 * Never throws: a failed send must not undo the approval. The failure
 * comes back as a result so the admin is told rather than it vanishing
 * into the logs.
 */
export async function sendApprovalEmail(
  input: { email: string; name: string | null | undefined },
  timeoutMs = APPROVAL_EMAIL_TIMEOUT_MS,
): Promise<ApprovalEmailResult> {
  const content = templates.accountApproved(input.name ?? "", portalApiKeysUrl());

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const send = getEmailProvider().then((provider) =>
      provider.send({
        to: input.email,
        subject: content.subject,
        textBody: content.textBody,
        htmlBody: content.htmlBody,
      }),
    );
    const sent = await Promise.race([send, deadline]);
    if (!sent) return { ok: false, reason: "provider_rejected" };
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[approveUser] approval email failed for ${input.email}: ${reason}`);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
