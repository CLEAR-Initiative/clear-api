/**
 * No-op email provider. Selected by `EMAIL_PROVIDER=none`.
 *
 * It accepts every send and delivers nothing — the safe default for any
 * context that must never put real mail on the wire (the test suite forces
 * it so a DB test can't email real users; an operator can also set it to
 * disable email on a deployment). Logs a single line per call so a silently
 * dropped message is still traceable.
 */

import type { EmailProvider, SendEmailOptions } from "../types.js";

export class NullEmailProvider implements EmailProvider {
  async send(options: SendEmailOptions): Promise<boolean> {
    console.log(
      `[NULL-EMAIL] dropped email: to=${options.to}, subject="${options.subject}"`,
    );
    return true;
  }

  async sendBulk(messages: SendEmailOptions[]): Promise<boolean[]> {
    if (messages.length > 0) {
      console.log(`[NULL-EMAIL] dropped ${messages.length} email(s)`);
    }
    return messages.map(() => true);
  }
}
