/**
 * Twilio webhook signature scheme, pinned to the worked example in
 * Twilio's security docs (https://www.twilio.com/docs/usage/security):
 * auth token "12345", the myapp.php URL + five params, expected
 * signature 0/KCTR6DLpKmkAf8muzZqo1nDgQ=. If the implementation drifts
 * from Twilio's scheme, this vector catches it.
 */

import { describe, it, expect } from "vitest";
import {
  computeTwilioSignature,
  validateTwilioSignature,
} from "../../src/services/twilio-signature.js";

const DOCS_URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const DOCS_TOKEN = "12345";
const DOCS_PARAMS = {
  CallSid: "CA1234567890ABCDE",
  Caller: "+12349013030",
  Digits: "1234",
  From: "+12349013030",
  To: "+18005551212",
};
const DOCS_SIGNATURE = "0/KCTR6DLpKmkAf8muzZqo1nDgQ=";

describe("computeTwilioSignature", () => {
  it("reproduces the documented example vector", () => {
    expect(computeTwilioSignature(DOCS_TOKEN, DOCS_URL, DOCS_PARAMS)).toBe(DOCS_SIGNATURE);
  });

  it("sorts parameter names before concatenation", () => {
    // Same params fed in a different insertion order — must not matter.
    const reordered = {
      To: "+18005551212",
      CallSid: "CA1234567890ABCDE",
      Digits: "1234",
      Caller: "+12349013030",
      From: "+12349013030",
    };
    expect(computeTwilioSignature(DOCS_TOKEN, DOCS_URL, reordered)).toBe(DOCS_SIGNATURE);
  });
});

describe("validateTwilioSignature", () => {
  it("accepts the correct signature", () => {
    expect(
      validateTwilioSignature({
        authToken: DOCS_TOKEN,
        signature: DOCS_SIGNATURE,
        url: DOCS_URL,
        params: DOCS_PARAMS,
      }),
    ).toBe(true);
  });

  it("rejects a missing signature header", () => {
    expect(
      validateTwilioSignature({
        authToken: DOCS_TOKEN,
        signature: undefined,
        url: DOCS_URL,
        params: DOCS_PARAMS,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(
      validateTwilioSignature({
        authToken: DOCS_TOKEN,
        signature: DOCS_SIGNATURE,
        url: DOCS_URL,
        params: { ...DOCS_PARAMS, Digits: "9999" },
      }),
    ).toBe(false);
  });

  it("rejects a signature computed for a different URL", () => {
    expect(
      validateTwilioSignature({
        authToken: DOCS_TOKEN,
        signature: DOCS_SIGNATURE,
        url: "https://mycompany.com/other.php",
        params: DOCS_PARAMS,
      }),
    ).toBe(false);
  });

  it("rejects a signature minted with a different auth token", () => {
    expect(
      validateTwilioSignature({
        authToken: "not-the-token",
        signature: DOCS_SIGNATURE,
        url: DOCS_URL,
        params: DOCS_PARAMS,
      }),
    ).toBe(false);
  });
});
