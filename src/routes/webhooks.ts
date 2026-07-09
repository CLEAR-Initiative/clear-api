/**
 * POST /webhooks/glitchtip
 *
 * GlitchTip's Alert Rules push here when an issue matches. We validate a
 * shared-secret query token, load matching subscriptions, persist a
 * WebhookDelivery row per subscription, and fire the first attempts in
 * the background. Response is 202 Accepted — delivery is asynchronous
 * from GlitchTip's perspective.
 *
 * GlitchTip's payload shape (as of 2025):
 *   { alias: string,            // event type slug, e.g. "issue.new"
 *     text: string,             // human-readable summary
 *     attachments: [...],       // Slack-style content
 *     ...various project + issue fields... }
 *
 * We treat the payload as opaque JSON — the ONLY thing we introspect
 * out of it are `alias` (→ eventType) and a best-effort event ID (used
 * for correlation in the admin UI). Everything else is forwarded
 * verbatim to subscribers.
 *
 * Not GraphQL because:
 *   - GlitchTip's webhook config only speaks HTTP + JSON body.
 *   - Splitting external-webhook receive from internal-CRUD API means
 *     we can rate-limit / route the two independently without affecting
 *     each other.
 */

import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { env } from "../utils/env.js";
import { attemptDelivery } from "../services/webhook/deliver.js";

const router = Router();

/**
 * Constant-time string compare. Returns false when lengths differ
 * (short-circuit is safe because `timingSafeEqual` throws on length
 * mismatch anyway — the branch here is just to avoid the throw).
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Best-effort extraction of a stable event ID from GlitchTip's payload
 *  for correlation. Falls back to a placeholder — the delivery is still
 *  useful without it, just harder to trace back to the source issue. */
function extractEventId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown";
  const p = payload as Record<string, unknown>;
  // GlitchTip currently sends `issue_id` at the top level for issue alerts.
  if (typeof p.issue_id === "string") return p.issue_id;
  if (typeof p.event_id === "string") return p.event_id;
  if (typeof p.id === "string") return p.id;
  return "unknown";
}

/** Extract the event type from GlitchTip's payload. GlitchTip populates
 *  `alias` on Slack-style webhooks (e.g. "issue.new"). Fall back to a
 *  generic tag so downstream filtering still lands somewhere. */
function extractEventType(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown";
  const p = payload as Record<string, unknown>;
  if (typeof p.alias === "string" && p.alias.length > 0) return p.alias;
  return "unknown";
}

router.post("/glitchtip", async (req: Request, res: Response) => {
  // Endpoint disabled if no token is configured — mirrors the pattern
  // used by the S3 upload route: explicit-off is safer than
  // silently-allowing.
  if (!env.GLITCHTIP_WEBHOOK_TOKEN) {
    return res.status(503).json({
      error: "Webhook receiver not configured",
    });
  }

  const providedToken = typeof req.query.token === "string" ? req.query.token : "";
  if (!providedToken || !constantTimeEqual(providedToken, env.GLITCHTIP_WEBHOOK_TOKEN)) {
    // 401, not 403 — the caller CAN authenticate (there is a mechanism),
    // they just presented a bad credential.
    return res.status(401).json({ error: "Invalid token" });
  }

  // express.json() must be mounted globally on the /webhooks path for
  // req.body to be populated here. See src/index.ts mounting order.
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "Body must be JSON object" });
  }

  const eventType = extractEventType(payload);
  const eventId = extractEventId(payload);

  // Fan out. `eventTypeFilter: []` matches all — postgres array_contains
  // logic would require special handling, so we filter in JS: cheaper
  // than expressing "empty OR contains X" in Prisma's where DSL and the
  // subscription set is small (dozens at most).
  const active = await prisma.webhookSubscription.findMany({
    where: { active: true },
    select: { id: true, eventTypeFilter: true },
  });

  const matching = active.filter(
    (s) => s.eventTypeFilter.length === 0 || s.eventTypeFilter.includes(eventType),
  );

  if (matching.length === 0) {
    // Nothing subscribed — record intent-to-log via response, no work.
    return res.status(202).json({ delivered_to: 0, event_type: eventType });
  }

  // Create one WebhookDelivery per matching subscription, then attempt
  // each in the background. We deliberately return BEFORE the attempts
  // complete so GlitchTip's HTTP call isn't blocked on downstream
  // latency (their retry logic is coarse; better to accept fast).
  const deliveries = await Promise.all(
    matching.map((s) =>
      prisma.webhookDelivery.create({
        data: {
          subscriptionId: s.id,
          eventId,
          eventType,
          requestBody: payload,
          // First attempt fires immediately below — no nextRetryAt yet.
        },
        select: { id: true },
      }),
    ),
  );

  // Fire attempts in the background. Each `attemptDelivery` updates the
  // row with outcome (success/failure/retry-scheduled). We `.catch` so
  // an unexpected exception doesn't create an unhandled-rejection.
  for (const d of deliveries) {
    void attemptDelivery(prisma, d.id).catch((e) => {
      console.error(`[webhook-receive] initial attempt ${d.id} threw:`, e);
    });
  }

  return res.status(202).json({
    delivered_to: deliveries.length,
    event_type: eventType,
  });
});

export const webhooksRouter = router;
