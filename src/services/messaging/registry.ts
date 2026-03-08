/**
 * Lazy-loading provider registry for messaging providers.
 *
 * Mirrors Django `messaging/registry.py`.
 * Providers are cached as singletons for the process lifetime.
 */

import type { EmailProvider, SMSProvider } from "./types.js";

let _emailProvider: EmailProvider | null = null;
let _smsProvider: SMSProvider | null = null;

/**
 * Get the configured email provider instance.
 *
 * Reads `EMAIL_PROVIDER` env var:
 *   - `"smtp"` (default) → SMTPEmailProvider
 *   - `"postmark"` → PostmarkEmailProvider
 */
export async function getEmailProvider(): Promise<EmailProvider> {
  if (_emailProvider) return _emailProvider;

  const providerName = (process.env.EMAIL_PROVIDER ?? "smtp").toLowerCase();

  switch (providerName) {
    case "postmark": {
      const { PostmarkEmailProvider } = await import(
        "./providers/postmark.js"
      );
      _emailProvider = new PostmarkEmailProvider();
      break;
    }
    case "smtp":
    default: {
      const { SMTPEmailProvider } = await import("./providers/smtp.js");
      _emailProvider = new SMTPEmailProvider();
      break;
    }
  }

  console.log(`[MESSAGING] Email provider loaded: ${providerName}`);
  return _emailProvider;
}

/**
 * Get the configured SMS provider instance.
 *
 * Reads `SMS_PROVIDER` env var:
 *   - `"twilio"` (default) → TwilioSMSProvider
 */
export async function getSMSProvider(): Promise<SMSProvider> {
  if (_smsProvider) return _smsProvider;

  const providerName = (process.env.SMS_PROVIDER ?? "twilio").toLowerCase();

  switch (providerName) {
    case "twilio":
    default: {
      const { TwilioSMSProvider } = await import(
        "./providers/twilio-sms.js"
      );
      _smsProvider = new TwilioSMSProvider();
      break;
    }
  }

  console.log(`[MESSAGING] SMS provider loaded: ${providerName}`);
  return _smsProvider;
}

/** Reset cached provider instances. Useful for testing. */
export function resetProviders(): void {
  _emailProvider = null;
  _smsProvider = null;
}
