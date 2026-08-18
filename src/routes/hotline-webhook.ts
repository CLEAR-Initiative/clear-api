/**
 * POST /api/webhooks/twilio/whatsapp — hotline webhook receiver, Twilio
 * transport (WhatsApp Signal Pipeline V3 POC, Exponential ticket #370).
 *
 * The V3 hotline is specced for Meta's WhatsApp Business Cloud API on a
 * DCH-allocated number, which is externally blocked. Twilio is itself an
 * official WhatsApp BSP, so its sandbox lets us build and exercise the
 * whole hotline path NOW: this route is a THIN Twilio adapter that
 * normalizes the webhook payload into the canonical
 * HotlineInboundMessage; everything below (services/hotline-ingest.ts)
 * is transport-agnostic. When the DCH number lands, a sibling route
 * speaking Meta's webhook dialect (JSON + hub challenge + media-id
 * fetch) replaces this one against the same service.
 *
 * Flow (all inline — media is small and Twilio allows ~15s; acking only
 * AFTER persistence keeps Twilio's retry semantics as our durability
 * net, and the MessageSid-based externalId makes retries idempotent):
 *   1. Config guard: the three hotline env vars must be set → else 503.
 *   2. Twilio signature validation against the EXACT configured public
 *      URL → else 403.
 *   3. Source gate: the receiving number must be a registered ACTIVE
 *      "hotline" ground source. Unknown number → 200 with nothing
 *      persisted (a retry cannot fix it) and a LOUD log line — same
 *      visibility contract as the live-ingest consent gate.
 *   4. Ingest: dedupe on MessageSid, fetch+store media to S3 (ground
 *      content-hash keys), redact, pseudonymize, placeholder thread.
 *   5. Enqueue classification (always, on create) and transcription
 *      (voice media only).
 *   6. Respond with EMPTY TwiML.
 *
 * NO OUTBOUND (ubiquitous PRD constraint pending NRC sign-off): the
 * TwiML response is itself a reply channel — a <Message> element here
 * would text the reporter back. The response is therefore always the
 * empty <Response/>, and nothing in this path calls any send API.
 */

import { Router, urlencoded, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { env } from "../utils/env.js";
import {
  ingestHotlineMessage,
  resolveHotlineSource,
  enqueueGroundTranscription,
  type HotlineInboundMedia,
} from "../services/hotline-ingest.js";
import { enqueueGroundClassification } from "../services/ground-classify.js";
import { validateTwilioSignature } from "../services/twilio-signature.js";
import { groundMediaKey } from "../services/ground-ingest.js";
import { uploadBufferToS3 } from "../services/s3.js";

const router = Router();

// Twilio sends application/x-www-form-urlencoded; extended:false yields
// the flat string map the signature scheme is defined over.
router.use(urlencoded({ extended: false, limit: "1mb" }));

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

function respondEmptyTwiml(res: Response): void {
  res.status(200).type("text/xml").send(EMPTY_TWIML);
}

/** "whatsapp:+14155238886" → "+14155238886" (groundSources.transportId
 * for hotline kind is the bare number; the channel prefix is Twilio's). */
export function stripChannelPrefix(address: string): string {
  return address.replace(/^whatsapp:/, "");
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/amr": "amr",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
};

/** Synthetic filename for a hotline attachment — groundMediaKey only uses
 * it for the extension (keys are content-hashed). */
export function hotlineMediaFilename(
  messageSid: string,
  index: number,
  contentType: string,
): string {
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = EXTENSION_BY_CONTENT_TYPE[bare];
  return `${messageSid}-${index}${ext ? `.${ext}` : ""}`;
}

/**
 * Fetch one attachment from Twilio and store it under the ground
 * content-hash key scheme. Twilio media URLs require HTTP basic auth
 * with the account credentials; fetch() drops the Authorization header
 * on the cross-origin redirect to their storage backend, which is the
 * correct behaviour.
 */
async function fetchAndStoreTwilioMedia(options: {
  groundSourceId: string;
  messageSid: string;
  media: HotlineInboundMedia;
  index: number;
}): Promise<string> {
  const credentials = Buffer.from(
    `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
  ).toString("base64");
  const response = await fetch(options.media.url, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!response.ok) {
    throw new Error(`media fetch failed: HTTP ${response.status} for media ${options.index}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = hotlineMediaFilename(options.messageSid, options.index, options.media.contentType);
  const key = groundMediaKey(options.groundSourceId, filename, buffer);
  await uploadBufferToS3(buffer, key, options.media.contentType);
  return key;
}

/** Pull MediaUrl{N}/MediaContentType{N} pairs out of the form params. */
export function extractMediaDescriptors(
  params: Record<string, string>,
): HotlineInboundMedia[] {
  const count = Number.parseInt(params.NumMedia ?? "0", 10);
  if (!Number.isFinite(count) || count <= 0) return [];
  const media: HotlineInboundMedia[] = [];
  for (let i = 0; i < count; i += 1) {
    const url = params[`MediaUrl${i}`];
    if (!url) continue;
    media.push({ url, contentType: params[`MediaContentType${i}`] ?? "" });
  }
  return media;
}

router.post("/", async (req: Request, res: Response) => {
  try {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, HOTLINE_WEBHOOK_URL, HOTLINE_PSEUDONYM_SECRET } =
      env;
    if (
      !TWILIO_ACCOUNT_SID ||
      !TWILIO_AUTH_TOKEN ||
      !HOTLINE_WEBHOOK_URL ||
      !HOTLINE_PSEUDONYM_SECRET
    ) {
      console.error(
        "[hotline-webhook] rejected: hotline env not configured " +
          "(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, HOTLINE_WEBHOOK_URL, HOTLINE_PSEUDONYM_SECRET)",
      );
      res.status(503).json({ error: "Hotline webhook is not configured" });
      return;
    }

    const params = req.body as Record<string, string>;
    const valid = validateTwilioSignature({
      authToken: TWILIO_AUTH_TOKEN,
      signature: req.headers["x-twilio-signature"] as string | undefined,
      url: HOTLINE_WEBHOOK_URL,
      params,
    });
    if (!valid) {
      res.status(403).json({ error: "Invalid Twilio signature" });
      return;
    }

    const messageSid = params.MessageSid;
    const from = params.From;
    const to = params.To;
    if (!messageSid || !from || !to) {
      res.status(400).json({ error: "Missing MessageSid, From, or To" });
      return;
    }

    const hotlineNumber = stripChannelPrefix(to);
    const gate = await resolveHotlineSource(prisma, hotlineNumber);
    if (!gate.ok) {
      // Part of the contract, like the live-ingest consent gate: a
      // submission dropped at the gate must be visible in the logs, not
      // silent. 200 (not 4xx) because a Twilio retry cannot fix this.
      console.warn(
        `[hotline-webhook] gate rejected message ${messageSid} to ${hotlineNumber}: ${gate.reason}`,
      );
      respondEmptyTwiml(res);
      return;
    }
    const source = gate.source;

    const result = await ingestHotlineMessage({
      db: prisma,
      source,
      message: {
        messageId: messageSid,
        senderHandle: from,
        // Twilio's webhook carries no message timestamp; receipt time is
        // the closest observable. Meta's Cloud API does carry one — the
        // future adapter should use it.
        sentAt: new Date(),
        text: params.Body ?? null,
        media: extractMediaDescriptors(params),
      },
      pseudonymSecret: HOTLINE_PSEUDONYM_SECRET,
      storeMedia: (media, index) =>
        fetchAndStoreTwilioMedia({ groundSourceId: source.id, messageSid, media, index }),
    });

    if (result.status === "created") {
      enqueueGroundClassification(source.id);
      if (result.hasAudio && result.groundMessageId) {
        enqueueGroundTranscription(result.groundMessageId);
      }
    }

    respondEmptyTwiml(res);
  } catch (err) {
    console.error("[hotline-webhook] Failed:", err);
    // 500 → Twilio retries; the MessageSid externalId makes that safe.
    res.status(500).json({ error: "Hotline ingest failed" });
  }
});

export { router as hotlineWebhookRouter };
