/**
 * REST endpoint for LIVE gateway ingestion into the ground staging tier.
 *
 * POST /api/ground/ingest  (application/json)
 *   Either one message object or `{ "messages": [ … ] }` (max 500).
 *   Message shape: { groupJid, messageId, senderJid, senderName?,
 *   timestamp, text?, mediaKeys?, mediaRefs?, isEdited? } — see
 *   services/ground-live-ingest.ts for field semantics.
 *
 * Auth: machine callers only — an API key (`Bearer sk_live_…`) belonging
 * to a `pipeline`-role user, the same mechanism the clear-pipeline
 * workers use for pipeline-facing mutations (utils/request-auth.ts).
 * Platform admins also pass, for manual testing.
 *
 * CONSENT GATE (hard): every group JID in the payload must resolve to an
 * ACTIVE groundSources row whose recorded consent covers message-content
 * capture. One unconsented JID rejects the WHOLE payload with 403 and
 * nothing persisted, and the rejection is logged with its reasons —
 * a repeated 403 burst in the logs means the gateway's capture allowlist
 * and the consent records have drifted apart.
 *
 * Success responses report created vs skipped counts; redelivery of the
 * same messages is idempotent (externalId "whatsapp:{jid}:{messageId}"
 * under the [groundSourceId, externalId] unique constraint).
 */

import { Router, json } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { resolveRequestAuth } from "../utils/request-auth.js";
import { ingestLiveMessages } from "../services/ground-live-ingest.js";
import { enqueueGroundClassification } from "../services/ground-classify.js";

const router = Router();

const GROUND_INGEST_ROLES = new Set(["admin", "pipeline"]);
const MAX_BATCH = 500;

const messageSchema = z.object({
  groupJid: z.string().min(1),
  messageId: z.string().min(1),
  senderJid: z.string().min(1),
  senderName: z.string().nullish(),
  timestamp: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "timestamp must be an ISO 8601 date"),
  text: z.string().nullish(),
  mediaKeys: z.array(z.string()).optional(),
  mediaRefs: z.array(z.string()).optional(),
  isEdited: z.boolean().optional(),
});

const bodySchema = z.union([
  z.object({ messages: z.array(messageSchema).min(1).max(MAX_BATCH) }),
  messageSchema,
]);

// Scoped body parser (same convention as /webhooks) — payloads are text
// messages, 5 MB is generous headroom for a large batch.
router.use(json({ limit: "5mb" }));

router.post("/", async (req, res) => {
  try {
    const { user } = await resolveRequestAuth(req.headers);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!GROUND_INGEST_ROLES.has(user.role ?? "")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid payload",
        details: parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      });
      return;
    }
    const messages = "messages" in parsed.data ? parsed.data.messages : [parsed.data];

    const result = await ingestLiveMessages({ db: prisma, messages });

    if (!result.ok) {
      // The log line is part of the contract: unconsented ingest attempts
      // must be visible, not silently dropped (PRD V2 acceptance).
      console.warn(
        `[ground-ingest] consent gate rejected payload (${messages.length} message(s)):`,
        result.rejections
          .map((r) => `${r.groupJid} — ${r.reason}`)
          .join("; "),
      );
      res.status(403).json({
        error: "Consent gate: live capture is not permitted for this payload",
        rejections: result.rejections,
      });
      return;
    }

    // Classification work exists for every source that gained rows.
    // Fire-and-forget — a broker hiccup must not fail a persisted ingest.
    for (const source of result.sources) {
      if (source.created > 0) {
        enqueueGroundClassification(source.groundSourceId);
      }
    }

    res.json({ created: result.created, skipped: result.skipped });
  } catch (err) {
    console.error("[ground-ingest] Failed:", err);
    res.status(500).json({ error: "Ingest failed" });
  }
});

export { router as groundIngestRouter };
