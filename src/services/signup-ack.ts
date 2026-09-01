/**
 * CLEAR-branded signup acknowledgement. Sent from this API so the
 * message is not "The Exponential team". CRM sync to prospects still
 * runs separately — disable Exponential's collection-join automation
 * or signups receive two acks.
 */

import { env } from "../utils/env.js";
import { getEmailProvider, templates } from "./messaging/index.js";

export function portalLoginUrl(): string {
  return `${env.BETTER_AUTH_URL.replace(/\/+$/, "")}/portal/login`;
}

export async function sendSignupAcknowledgement(input: {
  email: string;
  name: string | null | undefined;
}): Promise<void> {
  const content = templates.signupAcknowledgement(
    input.name ?? "",
    portalLoginUrl(),
  );

  try {
    const provider = await getEmailProvider();
    await provider.send({
      to: input.email,
      subject: content.subject,
      textBody: content.textBody,
      htmlBody: content.htmlBody,
    });
  } catch (error) {
    console.error(
      `[auth.signup] acknowledgement email failed for ${input.email}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
