/**
 * No-op SMS provider. Selected by `SMS_PROVIDER=none`.
 *
 * Mirror of {@link NullEmailProvider} for the SMS channel: accepts every send
 * and delivers nothing, so a test (or a deployment that disables SMS) can
 * never reach a real phone. Logs a line per call for traceability.
 */

import type { SMSProvider, SendSMSOptions } from "../types.js";

export class NullSMSProvider implements SMSProvider {
  async send(options: SendSMSOptions): Promise<boolean> {
    console.log(`[NULL-SMS] dropped sms: to=${options.to}`);
    return true;
  }
}
