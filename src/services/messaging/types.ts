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
  /**
   * Override the sender address. Defaults to the provider's configured
   * sender (`SMTP_FROM` / `POSTMARK_SENDER_EMAIL`). For multi-tenant
   * touchpoints we deliberately leave this at the platform default — the
   * `From` address must stay on a domain our ESP has verified — and brand
   * per-org via `fromName` + `replyTo` instead.
   */
  fromEmail?: string;
  /**
   * Display name for the `From` header (`"Name <addr>"`). Free-form text,
   * so it carries no deliverability cost — used to brand the sender with a
   * calling org's name while the address stays the platform's verified one.
   */
  fromName?: string;
  /**
   * `Reply-To` address. Lets replies to a platform-sent email route back to
   * a calling org's own mailbox without changing the authenticated `From`.
   */
  replyTo?: string;
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
