/**
 * The `none` messaging providers: the registry returns the Null providers, and
 * they drop every message without throwing or doing any I/O. This is the
 * backstop that keeps the suite from sending real email/SMS even if a `.env`
 * configures Postmark/Twilio — `tests/setup.ts` forces EMAIL_PROVIDER=none /
 * SMS_PROVIDER=none.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getEmailProvider,
  getSMSProvider,
  resetProviders,
} from "../../src/services/messaging/registry.js";
import { NullEmailProvider } from "../../src/services/messaging/providers/null-email.js";
import { NullSMSProvider } from "../../src/services/messaging/providers/null-sms.js";

beforeEach(() => {
  resetProviders();
  process.env.EMAIL_PROVIDER = "none";
  process.env.SMS_PROVIDER = "none";
});

describe("messaging registry — none", () => {
  it("returns the Null email provider, which accepts sends and delivers nothing", async () => {
    const provider = await getEmailProvider();
    expect(provider).toBeInstanceOf(NullEmailProvider);

    const one = await provider.send({ to: "a@b.co", subject: "s", textBody: "t" });
    expect(one).toBe(true);
    const many = await provider.sendBulk([
      { to: "a@b.co", subject: "s", textBody: "t" },
      { to: "c@d.co", subject: "s", textBody: "t" },
    ]);
    expect(many).toEqual([true, true]);
  });

  it("returns the Null SMS provider, which accepts sends and delivers nothing", async () => {
    const provider = await getSMSProvider();
    expect(provider).toBeInstanceOf(NullSMSProvider);
    expect(await provider.send({ to: "+10000000000", body: "hi" })).toBe(true);
  });
});
