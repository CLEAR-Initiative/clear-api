/**
 * Postmark email provider using the Postmark HTTP API.
 *
 * Mirrors Django `messaging/providers/postmark.py`.
 * Uses native fetch — no third-party SDK required.
 *
 * Required env vars:
 *   POSTMARK_SERVER_TOKEN, POSTMARK_SENDER_EMAIL (optional)
 */

import type { EmailProvider, SendEmailOptions } from "../types.js";

const POSTMARK_API_URL = "https://api.postmarkapp.com";

export class PostmarkEmailProvider implements EmailProvider {
  private serverToken: string;
  private senderEmail: string;

  constructor() {
    this.serverToken = process.env.POSTMARK_SERVER_TOKEN ?? "";
    this.senderEmail =
      process.env.POSTMARK_SENDER_EMAIL ??
      process.env.SMTP_FROM ??
      "noreply@clear-platform.org";

    if (!this.serverToken) {
      console.warn(
        "[POSTMARK] POSTMARK_SERVER_TOKEN is not configured. Email sending will fail.",
      );
    }

    console.log(
      `[POSTMARK] Provider initialized: sender=${this.senderEmail}`,
    );
  }

  private async makeRequest(
    endpoint: string,
    payload: unknown,
  ): Promise<unknown> {
    const url = `${POSTMARK_API_URL}${endpoint}`;
    const body = JSON.stringify(payload);
    console.log(`[POSTMARK] POST ${url} (${body.length} bytes)`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.serverToken,
      },
      body,
    });

    const responseBody = await response.text();
    console.log(
      `[POSTMARK] Response: HTTP ${response.status}, ${responseBody.length} bytes`,
    );

    if (!response.ok) {
      throw new Error(
        `Postmark API returned ${response.status}: ${responseBody}`,
      );
    }

    return JSON.parse(responseBody) as unknown;
  }

  async send(options: SendEmailOptions): Promise<boolean> {
    const from = options.fromEmail ?? this.senderEmail;
    console.log(
      `[POSTMARK] Sending email: to=${options.to}, from=${from}, subject="${options.subject}"`,
    );

    const payload: Record<string, string> = {
      From: from,
      To: options.to,
      Subject: options.subject,
      TextBody: options.textBody,
    };
    if (options.htmlBody) {
      payload.HtmlBody = options.htmlBody;
    }

    const result = (await this.makeRequest("/email", payload)) as Record<
      string,
      unknown
    >;

    if (result.ErrorCode && result.ErrorCode !== 0) {
      const msg = (result.Message as string) ?? "Unknown Postmark error";
      console.error(
        `[POSTMARK] FAILED to ${options.to}: ErrorCode=${result.ErrorCode}, Message=${msg}`,
      );
      throw new Error(`Postmark error: ${msg}`);
    }

    console.log(
      `[POSTMARK] SUCCESS: Email sent to ${options.to}, MessageID=${result.MessageID}`,
    );
    return true;
  }

  async sendBulk(messages: SendEmailOptions[]): Promise<boolean[]> {
    if (messages.length === 0) return [];

    const results: boolean[] = [];

    // Process in chunks of 500 (Postmark batch limit)
    for (let i = 0; i < messages.length; i += 500) {
      const chunk = messages.slice(i, i + 500);
      const batchPayload = chunk.map((msg) => {
        const item: Record<string, string> = {
          From: msg.fromEmail ?? this.senderEmail,
          To: msg.to,
          Subject: msg.subject,
          TextBody: msg.textBody,
        };
        if (msg.htmlBody) {
          item.HtmlBody = msg.htmlBody;
        }
        return item;
      });

      try {
        const response = (await this.makeRequest(
          "/email/batch",
          batchPayload,
        )) as Array<Record<string, unknown>>;

        for (const item of response) {
          results.push(item.ErrorCode === 0);
        }
      } catch (error) {
        console.error("[POSTMARK] Batch send failed:", error);
        results.push(...new Array<boolean>(chunk.length).fill(false));
      }
    }

    return results;
  }
}
