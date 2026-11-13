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
 *   - `"none"` → NullEmailProvider (drops every message — the test suite
 *     forces this so no test can send real mail; also disables email on a
 *     deployment that sets it)
 */
export async function getEmailProvider(): Promise<EmailProvider> {
  if (_emailProvider) return _emailProvider;

  const providerName = (process.env.EMAIL_PROVIDER ?? "smtp").toLowerCase();

  switch (providerName) {
    case "none": {
      const { NullEmailProvider } = await import("./providers/null-email.js");
      _emailProvider = new NullEmailProvider();
      break;
    }
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
 *   - `"46elks"` → Elks46SMSProvider
 *   - `"none"` → NullSMSProvider (drops every message; forced in tests)
 */
export async function getSMSProvider(): Promise<SMSProvider> {
  if (_smsProvider) return _smsProvider;

  const providerName = (process.env.SMS_PROVIDER ?? "twilio").toLowerCase();

  switch (providerName) {
    case "none": {
      const { NullSMSProvider } = await import("./providers/null-sms.js");
      _smsProvider = new NullSMSProvider();
      break;
    }
    case "46elks":
    case "elks46":
    case "elks": {
      const { Elks46SMSProvider } = await import(
        "./providers/elks46-sms.js"
      );
      _smsProvider = new Elks46SMSProvider();
      break;
    }
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
