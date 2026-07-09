/**
 * HMAC-SHA256 signing for outbound webhooks. GitHub-style header format:
 *
 *   X-Signature:   sha256=<hex>
 *   X-Timestamp:   <unix seconds>
 *   X-Delivery-Id: <uuid>
 *   X-Event-Type:  <event type from source payload>
 *
 * The signature is computed over the RAW request body only — not over
 * timestamp + body concatenation. Verifiers should:
 *
 *   1. Reject if X-Timestamp is > 5 minutes old (replay window).
 *   2. Compute their own HMAC-SHA256 over the raw body with the shared
 *      secret and compare to the value in X-Signature using
 *      constant-time comparison.
 *
 * We keep signature = HMAC(body) (not HMAC(timestamp|body)) so verifier
 * libraries built for GitHub's webhook scheme work unchanged. Replay
 * protection lives in the timestamp header check, which every serious
 * verifier already implements.
 */

import { createHmac } from "node:crypto";

export interface SignedRequestHeaders {
  "X-Signature": string;
  "X-Timestamp": string;
  "X-Delivery-Id": string;
  "X-Event-Type": string;
  "Content-Type": "application/json";
}

/**
 * Compute the outbound headers for a single delivery attempt. Callers
 * pass the raw serialized body (bytes-identical to what will be POSTed);
 * we return everything they need to attach to the fetch() call.
 */
export function signWebhookRequest(args: {
  body: string;
  secret: string;
  deliveryId: string;
  eventType: string;
}): SignedRequestHeaders {
  const signature = createHmac("sha256", args.secret)
    .update(args.body)
    .digest("hex");

  return {
    "X-Signature": `sha256=${signature}`,
    "X-Timestamp": Math.floor(Date.now() / 1000).toString(),
    "X-Delivery-Id": args.deliveryId,
    "X-Event-Type": args.eventType,
    "Content-Type": "application/json",
  };
}
