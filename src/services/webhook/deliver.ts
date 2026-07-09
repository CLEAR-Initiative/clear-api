/**
 * Single-attempt delivery of a WebhookDelivery row. Callers (the retry
 * worker OR the receive route for the first attempt) hand us a delivery
 * ID; we load it, POST to the subscription's target, update the row
 * in-place with the outcome, and return.
 *
 * We deliberately don't decide "should this be retried" here — the
 * worker's next tick will pick this row up if we set nextRetryAt.
 * Keeping the schedule policy in one place (worker) means changing the
 * backoff curve is one edit, not two.
 */

import type { PrismaClient } from "../../generated/prisma/client.js";
import { signWebhookRequest } from "./sign.js";

/** Backoff schedule (ms) for attempts 1..5. `attemptNumber` is the just-
 * completed failing attempt; we look up `BACKOFF_MS[attemptNumber]` to
 * find the delay before the NEXT attempt. Index 5 is out of range —
 * that means we've exhausted retries and mark the row dead-lettered. */
const BACKOFF_MS: readonly number[] = [
  1_000, // after attempt 1 fails: retry in 1s
  5_000, // after attempt 2 fails: retry in 5s
  30_000, // after attempt 3 fails: retry in 30s
  300_000, // after attempt 4 fails: retry in 5 min
  1_800_000, // after attempt 5 fails: retry in 30 min → then DLQ
];

/** Max attempts before the delivery is marked dead-lettered. */
export const MAX_ATTEMPTS = 5;

/** Request timeout — the target must respond within this or we treat
 * it as a failed attempt. Kept generous so slow-but-alive downstreams
 * don't get DLQ'd, but short enough that the worker stays responsive. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface DeliverResult {
  status: "succeeded" | "retry_scheduled" | "dead_lettered";
  responseStatus: number | null;
  attempt: number;
}

/**
 * Attempt to deliver `deliveryId`. Assumes the caller has already:
 *   - Created the row with attemptNumber=1 (for the first attempt), OR
 *   - Advanced the row's attemptNumber past a previous failure (for retries)
 *
 * Loads the row + subscription, POSTs, updates outcome fields, returns.
 *
 * If the subscription has been deleted between selection and attempt,
 * we mark the delivery as errored with a clear message and stop — no
 * point retrying a subscription that no longer exists.
 */
export async function attemptDelivery(
  prisma: PrismaClient,
  deliveryId: string,
): Promise<DeliverResult> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { subscription: true },
  });

  if (!delivery) {
    // Row was deleted between selection and now (unlikely — no delete
    // path exists yet — but future-proof).
    return { status: "dead_lettered", responseStatus: null, attempt: 0 };
  }

  if (delivery.succeededAt) {
    // Already delivered on a previous attempt; another worker tick
    // picked it up before we cleared nextRetryAt. Safe no-op.
    return {
      status: "succeeded",
      responseStatus: delivery.responseStatus,
      attempt: delivery.attemptNumber,
    };
  }

  const subscription = delivery.subscription;
  if (!subscription || !subscription.active) {
    // Subscription paused/deleted — stop retrying, mark errored.
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        error: "Subscription no longer active",
        nextRetryAt: null,
      },
    });
    return {
      status: "dead_lettered",
      responseStatus: null,
      attempt: delivery.attemptNumber,
    };
  }

  // Serialize once — the signature must be computed over EXACTLY the
  // bytes we POST. JSON.stringify(x) here and re-serializing in
  // fetch(..., { body: JSON.stringify(x) }) would produce byte-identical
  // output, but keeping one canonical `body` variable makes it obvious.
  const body = JSON.stringify(delivery.requestBody);
  const headers = signWebhookRequest({
    body,
    secret: subscription.secret,
    deliveryId: delivery.id,
    eventType: delivery.eventType,
  });

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(subscription.targetUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      responseStatus = res.status;
      // Cap stored body at 8 KiB — enough to see what the target said
      // without letting a chatty error page blow up our storage.
      const text = await res.text();
      responseBody = text.length > 8192 ? text.slice(0, 8192) + "…[truncated]" : text;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // Network error, DNS failure, TLS error, timeout — all end up here.
    error = e instanceof Error ? e.message : String(e);
  }

  const succeeded = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
  const attempt = delivery.attemptNumber;

  if (succeeded) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        responseStatus,
        responseBody,
        error: null,
        succeededAt: new Date(),
        nextRetryAt: null,
      },
    });
    return { status: "succeeded", responseStatus, attempt };
  }

  // Failed. Decide retry vs DLQ based on attempt count.
  const backoffMs = BACKOFF_MS[attempt - 1];
  const isDeadLettered = attempt >= MAX_ATTEMPTS || backoffMs === undefined;

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      responseStatus,
      responseBody,
      error,
      nextRetryAt: isDeadLettered ? null : new Date(Date.now() + backoffMs),
    },
  });

  return {
    status: isDeadLettered ? "dead_lettered" : "retry_scheduled",
    responseStatus,
    attempt,
  };
}
