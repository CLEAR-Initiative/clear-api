/**
 * 46elks SMS provider.
 *
 * Uses the 46elks REST API with HTTP Basic auth.
 * Docs: https://46elks.com/docs/send-sms
 *
 * Required env vars:
 *   ELKS46_API_USERNAME     — API username (from 46elks dashboard)
 *   ELKS46_API_PASSWORD     — API password
 *   ELKS46_FROM             — sender ID (alphanumeric, max 11 chars) or E.164 number
 */

import type { SMSProvider, SendSMSOptions } from "../types.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("sms:46elks");
const API_URL = "https://api.46elks.com/a1/sms";

export class Elks46SMSProvider implements SMSProvider {
  private readonly username: string;
  private readonly password: string;
  private readonly from: string;

  constructor() {
    this.username = process.env.ELKS46_API_USERNAME ?? "";
    this.password = process.env.ELKS46_API_PASSWORD ?? "";
    this.from = process.env.ELKS46_FROM ?? "";

    if (!this.username || !this.password || !this.from) {
      log.warn(
        "46elks SMS provider missing config — ELKS46_API_USERNAME, ELKS46_API_PASSWORD, and ELKS46_FROM are required",
      );
    }
  }

  async send({ to, body }: SendSMSOptions): Promise<boolean> {
    if (!this.username || !this.password || !this.from) {
      throw new Error(
        "46elks SMS provider not configured. Set ELKS46_API_USERNAME, ELKS46_API_PASSWORD, and ELKS46_FROM.",
      );
    }

    const auth = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    const params = new URLSearchParams({
      from: this.from,
      to,
      message: body,
    });

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      log.error({ status: res.status, body: errText, to }, "46elks SMS send failed");
      return false;
    }

    const data = (await res.json()) as { id?: string; status?: string };
    log.info({ id: data.id, status: data.status, to }, "46elks SMS sent");
    return true;
  }
}
