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
 * AFTER persistence, and the MessageSid-based externalId makes retries
 * idempotent). DURABILITY: Twilio does NOT retry a 5xx by default — its
 * default webhook retry policy is one retry on connect timeout only
 * (connection override `rp=ct`). A 5xx retry has to be enabled on the
 * Twilio side, by appending `#rp=5xx,ct&rc=3` to the webhook URL in the
 * console or configuring a Fallback URL to this same endpoint (see
 * .env.example). The ingest service therefore persists the message row
 * BEFORE fetching media, so a transient media/S3 failure leaves a
 * retrievable message rather than nothing; a retry backfills the media.
 *   1. Config guard: the three hotline env vars must be set → else 503.
 *   2. Twilio signature validation against the EXACT configured public
 *      URL → else 403.
 *   3. Source gate: the receiving number must be a registered ACTIVE
 *      "hotline" ground source. Unknown number → 200 with nothing
 *      persisted (a retry cannot fix it) and a LOUD log line — same
 *      visibility contract as the live-ingest consent gate.
 *   4. Ingest: dedupe on MessageSid, redact, pseudonymize, placeholder
 *      thread, THEN fetch+store media to S3 (ground content-hash keys)
 *      and fill in mediaKeys.
 *   5. Enqueue classification (on create / media backfill) and
 *      transcription (voice media only).
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

/** Per-attachment fetch budget. Twilio's webhook timeout is ~15s and
 * attachments are fetched concurrently, so one slow media edge fails
 * fast and deterministically instead of stalling the whole request into
 * a Twilio-side timeout. */
export const HOTLINE_MEDIA_FETCH_TIMEOUT_MS = 8_000;
/** WhatsApp caps media at 16MB; anything larger is not a legitimate
 * attachment and must not be buffered. */
export const MAX_HOTLINE_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * Fetch one attachment from Twilio and store it under the ground
 * content-hash key scheme. Twilio media URLs require HTTP basic auth
 * with the account credentials; fetch() drops the Authorization header
 * on the cross-origin redirect to their storage backend, which is the
 * correct behaviour. Bounded by HOTLINE_MEDIA_FETCH_TIMEOUT_MS and
 * MAX_HOTLINE_MEDIA_BYTES; either violation throws so the route's catch
 * path returns 500.
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
    signal: AbortSignal.timeout(HOTLINE_MEDIA_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`media fetch failed: HTTP ${response.status} for media ${options.index}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_HOTLINE_MEDIA_BYTES) {
    throw new Error(`media ${options.index} too large: ${declaredLength} bytes`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  // content-length is advisory (chunked responses omit it) — enforce on
  // the bytes actually received too.
  if (buffer.length > MAX_HOTLINE_MEDIA_BYTES) {
    throw new Error(`media ${options.index} too large: ${buffer.length} bytes`);
  }
  const filename = hotlineMediaFilename(options.messageSid, options.index, options.media.contentType);
  const key = groundMediaKey(options.groundSourceId, filename, buffer);
  await uploadBufferToS3(buffer, key, options.media.contentType);
  return key;
}

/**
 * Coerce the parsed body into the flat string map the signature scheme is
 * defined over. Express 5 leaves `req.body` UNDEFINED when no parser
 * matched the content type (a JSON or empty POST from a scanner), and
 * `urlencoded({extended:false})` yields string[] for repeated keys; both
 * must fall through to the signature check (→ 403), not throw (→ 500).
 * Twilio never sends repeated keys, so the first value is kept only to
 * keep the map typed — such a request fails the signature check anyway.
 */
export function normalizeFormParams(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null) return {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") params[key] = first;
  }
  return params;
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

    const params = normalizeFormParams(req.body);
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

    // "created" and "media_backfilled" are both the first fully
    // successful ingest of this message (see HotlineIngestResult).
    if (result.status !== "duplicate") {
      enqueueGroundClassification(source.id);
      if (result.hasAudio) {
        enqueueGroundTranscription(result.groundMessageId);
      }
    }

    respondEmptyTwiml(res);
  } catch (err) {
    console.error("[hotline-webhook] Failed:", err);
    // 500 is NOT retried by Twilio unless the webhook URL carries the
    // `#rp=5xx` connection override or a Fallback URL is set (module
    // doc). With the override, the retry is safe: the MessageSid
    // externalId dedupes and the media backfill completes a partial row.
    res.status(500).json({ error: "Hotline ingest failed" });
  }
});

export { router as hotlineWebhookRouter };
