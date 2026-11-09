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

/**
 * Never throws: a failed send must not undo the approval. The failure
 * comes back as a result so the admin is told rather than it vanishing
 * into the logs.
 */
export async function sendApprovalEmail(input: {
  email: string;
  name: string | null | undefined;
}): Promise<ApprovalEmailResult> {
  const content = templates.accountApproved(input.name ?? "", portalApiKeysUrl());

  try {
    const provider = await getEmailProvider();
    const sent = await provider.send({
      to: input.email,
      subject: content.subject,
      textBody: content.textBody,
      htmlBody: content.htmlBody,
    });
    if (!sent) return { ok: false, reason: "provider_rejected" };
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[approveUser] approval email failed for ${input.email}: ${reason}`);
    return { ok: false, reason };
  }
}
