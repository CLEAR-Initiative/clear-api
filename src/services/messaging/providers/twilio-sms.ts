/**
 * Twilio SMS provider stub.
 *
 * Mirrors Django `messaging/providers/twilio_sms.py`.
 * Ready for future implementation with the Twilio SDK.
 *
 * Required env vars (when implemented):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 */

import type { SMSProvider, SendSMSOptions } from "../types.js";

export class TwilioSMSProvider implements SMSProvider {
  constructor() {
    console.warn(
      "[TWILIO] SMS provider is a stub. Install 'twilio' package and implement to enable SMS.",
    );
  }

  async send(_options: SendSMSOptions): Promise<boolean> {
    throw new Error(
      "TwilioSMSProvider is a stub. Install the 'twilio' package and implement send().",
    );
  }
}
