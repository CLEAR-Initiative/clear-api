/**
 * Abstract messaging provider interfaces.
 *
 * Mirrors the Django `messaging/base.py` pattern — each delivery channel
 * (email, SMS) has a pluggable provider that can be swapped via env vars.
 */

/* ─── Email ─────────────────────────────────────────────────────────────────── */

export interface SendEmailOptions {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  fromEmail?: string;
}

export interface EmailProvider {
  /**
   * Send a single email.
   * @returns true if the email was sent successfully
   */
  send(options: SendEmailOptions): Promise<boolean>;

  /**
   * Send multiple emails.
   * @returns Array of booleans indicating success/failure for each message
   */
  sendBulk(messages: SendEmailOptions[]): Promise<boolean[]>;
}

/* ─── SMS ───────────────────────────────────────────────────────────────────── */

export interface SendSMSOptions {
  /** Recipient phone number in E.164 format (e.g. +249912345678) */
  to: string;
  /** SMS message body */
  body: string;
}

export interface SMSProvider {
  /**
   * Send a single SMS message.
   * @returns true if the message was sent successfully
   */
  send(options: SendSMSOptions): Promise<boolean>;
}
