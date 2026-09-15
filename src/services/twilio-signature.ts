/**
 * Twilio webhook signature validation (X-Twilio-Signature), implemented
 * against Twilio's documented scheme so the hotline webhook can verify
 * provenance without pulling in the `twilio` SDK (whose only use here
 * would be this one function — the messaging provider is a stub too).
 *
 * Scheme (https://www.twilio.com/docs/usage/security#validating-requests):
 *   1. Start with the full webhook URL EXACTLY as Twilio requested it
 *      (scheme, host, path, query). This must be configured server-side
 *      (env HOTLINE_WEBHOOK_URL) — reconstructing it from proxy headers
 *      is spoofable.
 *   2. For form-encoded POSTs, sort the body parameter NAMES
 *      alphabetically and append each name immediately followed by its
 *      value to the URL string.
 *   3. HMAC-SHA1 the resulting string with the account's auth token,
 *      base64-encode, and compare to the X-Twilio-Signature header.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time equality; false on length mismatch instead of throwing. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

/**
 * Validate an incoming Twilio webhook. `params` is the parsed
 * form-encoded body (express.urlencoded with extended:false yields
 * exactly the flat string map the scheme expects).
 */
export function validateTwilioSignature(options: {
  authToken: string;
  /** Value of the X-Twilio-Signature header, if present. */
  signature: string | undefined;
  /** The EXACT public URL Twilio was configured to call. */
  url: string;
  params: Record<string, string>;
}): boolean {
  if (!options.signature) return false;
  const expected = computeTwilioSignature(options.authToken, options.url, options.params);
  return constantTimeEqual(expected, options.signature);
}
