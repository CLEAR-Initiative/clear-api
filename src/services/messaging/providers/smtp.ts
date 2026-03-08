/**
 * SMTP email provider using nodemailer.
 *
 * Mirrors Django `messaging/providers/smtp.py`.
 *
 * Required env vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { EmailProvider, SendEmailOptions } from "../types.js";

export class SMTPEmailProvider implements EmailProvider {
  private transporter: Transporter;
  private defaultFrom: string;

  constructor() {
    const host = process.env.SMTP_HOST ?? "";
    const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
    const user = process.env.SMTP_USER ?? "";
    const pass = process.env.SMTP_PASS ?? "";
    this.defaultFrom =
      process.env.SMTP_FROM ?? "noreply@clear-platform.org";

    if (!host) {
      console.warn(
        "[SMTP] SMTP_HOST is not configured. Email sending will fail.",
      );
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
    });

    console.log(
      `[SMTP] Provider initialized: host=${host}, port=${port}, from=${this.defaultFrom}`,
    );
  }

  async send(options: SendEmailOptions): Promise<boolean> {
    const from = options.fromEmail ?? this.defaultFrom;
    console.log(
      `[SMTP] Sending email: to=${options.to}, from=${from}, subject="${options.subject}"`,
    );

    try {
      const info = await this.transporter.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        text: options.textBody,
        html: options.htmlBody,
      });

      console.log(
        `[SMTP] SUCCESS: Email sent to ${options.to}, messageId=${info.messageId}`,
      );
      return true;
    } catch (error) {
      console.error(
        `[SMTP] FAILED to ${options.to}:`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }
  }

  async sendBulk(messages: SendEmailOptions[]): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const msg of messages) {
      try {
        const success = await this.send(msg);
        results.push(success);
      } catch {
        results.push(false);
      }
    }
    return results;
  }
}
