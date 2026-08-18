/**
 * Hotline ingestion into the ground staging tier — the transport-agnostic
 * half of the WhatsApp Signal Pipeline V3 hotline adapter (Exponential
 * ticket #370). The webhook route (routes/hotline-webhook.ts, Twilio
 * transport for the POC) normalizes its payload into HotlineInboundMessage
 * and everything below that shape is transport-independent: when the
 * DCH-allocated number arrives on Meta's Business Cloud API, only a new
 * thin route is needed — this service does not change.
 *
 * What is DIFFERENT from the group paths (ground-ingest / ground-live-ingest):
 *
 *   - ANONYMITY IS STRICTER (ticket requirement: "no senderName/senderRef
 *     persisted; per-conversation pseudonym"). senderName is always null.
 *     The senderRef column carries a per-conversation pseudonym
 *     ("h_" + 12 hex) derived via HMAC-SHA256 with a server-side secret —
 *     NOT a plain hash like the group paths' deriveSenderRef. A plain
 *     sha256 of a phone number is dictionary-attackable (the phone-number
 *     space is small); the keyed HMAC is not reversible without the
 *     secret. In a 1:1 hotline chat, sender ↔ hotline IS the
 *     conversation, so the pseudonym is stable per conversation: a
 *     reviewer can see "same reporter, three messages" without anything
 *     resolvable back to a phone number.
 *
 *   - THE GATE IS KIND + ACTIVE, NOT CONSENT SCOPE. Group capture is
 *     unattended surveillance and needs recorded consent; a hotline
 *     submission is explicit by design — the reporter chose to message
 *     the number (PRD §2). The gate therefore requires an ACTIVE
 *     groundSources row of kind "hotline" for the receiving number and
 *     nothing else. Unknown numbers are rejected with nothing persisted.
 *
 *   - VOICE triggers a transcription enqueue. Audio media on a created
 *     message fires the clear-pipeline `transcribe_ground_message` task
 *     (fire-and-forget, same contract style as classify_ground_messages;
 *     the pipeline-side task is V3 work in clear-pipeline).
 *
 * Shared with the group paths: phone-number redaction at persistence,
 * uncertainty-marker extraction, placeholder thread per message, and the
 * "whatsapp:{transportId}:{messageId}" externalId idempotency scheme.
 *
 * NO OUTBOUND: nothing in this module (or the route) ever sends a message
 * to the reporter — the PRD's ubiquitous constraint pending NRC sign-off.
 */

import { createHmac } from "node:crypto";
import {
  extractUncertaintyMarker,
  redactPhoneNumbers,
} from "./whatsapp-export.js";
import {
  deriveThreadTitle,
  type GroundIngestDb,
  type GroundMessageCreate,
} from "./ground-ingest.js";
import { sendCeleryTask } from "./celery.js";

/** The slice of a groundSources row the hotline gate judges. */
export interface HotlineSourceRow {
  id: string;
  kind: string;
  transportId: string;
  isActive: boolean;
}

export interface HotlineIngestDb {
  groundSources: {
    findFirst(args: {
      where: { transportId: string };
    }): Promise<HotlineSourceRow | null>;
  };
  groundMessages: GroundIngestDb["groundMessages"] & {
    findFirst(args: {
      where: { groundSourceId: string; externalId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  groundThreads: GroundIngestDb["groundThreads"];
}

/** One media attachment on an inbound hotline message, not yet stored. */
export interface HotlineInboundMedia {
  /** Transport URL to fetch the bytes from (Twilio MediaUrl{N}). */
  url: string;
  /** MIME type as reported by the transport ("audio/ogg", "image/jpeg"). */
  contentType: string;
}

/** Canonical inbound hotline message — what a transport route produces. */
export interface HotlineInboundMessage {
  /** Upstream message id (Twilio MessageSid / Meta wamid) — unique and
   * stable on webhook retry, which is what makes ingest idempotent. */
  messageId: string;
  /** Reporter's transport handle (e.g. "whatsapp:+249…"). Fed to the
   * pseudonym HMAC, NEVER persisted. */
  senderHandle: string;
  sentAt: Date;
  /** Message text, if any. Redacted at persistence. */
  text: string | null;
  media: HotlineInboundMedia[];
}

export type ResolveHotlineSourceResult =
  | { ok: true; source: HotlineSourceRow }
  | { ok: false; reason: string };

/**
 * Gate: the receiving number must be a registered, ACTIVE hotline source.
 * `hotlineNumber` is the transportId form — bare E.164 (e.g.
 * "+14155238886"), i.e. the transport's channel prefix already stripped.
 */
export async function resolveHotlineSource(
  db: HotlineIngestDb,
  hotlineNumber: string,
): Promise<ResolveHotlineSourceResult> {
  const source = await db.groundSources.findFirst({
    where: { transportId: hotlineNumber },
  });
  if (!source) {
    return { ok: false, reason: "no ground source registered for this number" };
  }
  if (source.kind !== "hotline") {
    return {
      ok: false,
      reason: `ground source for this number has kind "${source.kind}", not "hotline"`,
    };
  }
  if (!source.isActive) {
    return { ok: false, reason: "hotline source is deactivated" };
  }
  return { ok: true, source };
}

/**
 * Per-conversation pseudonym: "h_" + 12 hex of
 * HMAC-SHA256(secret, transportId | senderHandle). The "h_" prefix keeps
 * hotline refs visually distinct from the group paths' "s_" refs in
 * review UIs. See the module doc for why this is keyed, not a bare hash.
 */
export function hotlinePseudonym(
  secret: string,
  transportId: string,
  senderHandle: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(`${transportId}|${senderHandle}`)
    .digest("hex");
  return `h_${digest.slice(0, 12)}`;
}

export function hotlineExternalId(transportId: string, messageId: string): string {
  return `whatsapp:${transportId}:${messageId}`;
}

export type HotlineIngestResult =
  | { status: "duplicate" }
  | {
      status: "created";
      groundMessageId: string;
      threadId: string;
      /** True when any stored media is audio — the caller enqueues
       * transcription for the message. */
      hasAudio: boolean;
    };

/**
 * Ingest one hotline message. Media bytes are fetched/stored via the
 * injected `storeMedia` ONLY after the duplicate check, so webhook
 * retries do not re-download media (content-hash keys make a re-store
 * harmless anyway, but the fetch is the expensive part).
 *
 * The caller resolves the source first (resolveHotlineSource) — media
 * must never be fetched, let alone stored, for an unregistered number.
 */
export async function ingestHotlineMessage(options: {
  db: HotlineIngestDb;
  source: HotlineSourceRow;
  message: HotlineInboundMessage;
  /** Secret for the pseudonym HMAC (env HOTLINE_PSEUDONYM_SECRET). */
  pseudonymSecret: string;
  /** Fetches one attachment's bytes and stores them under the ground
   * content-hash key scheme; returns the S3 key. Injected so tests (and
   * the route) control the transport fetch + S3 dependency. */
  storeMedia: (media: HotlineInboundMedia, index: number) => Promise<string>;
}): Promise<HotlineIngestResult> {
  const { db, source, message } = options;

  const externalId = hotlineExternalId(source.transportId, message.messageId);
  const existing = await db.groundMessages.findMany({
    where: { groundSourceId: source.id, externalId: { in: [externalId] } },
    select: { externalId: true },
  });
  if (existing.length > 0) {
    return { status: "duplicate" };
  }

  const mediaKeys: string[] = [];
  for (const [index, media] of message.media.entries()) {
    mediaKeys.push(await options.storeMedia(media, index));
  }

  const text = redactPhoneNumbers(message.text ?? "");
  const hasAudio = message.media.some((m) => m.contentType.startsWith("audio/"));
  /** Human-readable media labels for the review UI (groundMessages.mediaRefs
   * documents export filenames; the hotline has none, so label by type). */
  const mediaRefs = message.media.map(
    (m, i) => `${m.contentType.startsWith("audio/") ? "voice" : "media"}-${i}`,
  );

  const data: GroundMessageCreate = {
    groundSourceId: source.id,
    externalId,
    sentAt: message.sentAt,
    senderRef: hotlinePseudonym(options.pseudonymSecret, source.transportId, message.senderHandle),
    // Hotline anonymity: no display name is ever persisted.
    senderName: null,
    text,
    mediaKeys,
    mediaRefs,
    omittedMediaCount: 0,
    uncertainty: extractUncertaintyMarker(text),
    isEdited: false,
  };

  try {
    const thread = await db.groundThreads.create({
      data: {
        groundSourceId: source.id,
        title: deriveThreadTitle(text, mediaRefs, 0),
        messages: { create: data },
      },
    });
    // The nested create returns the thread id; the message id is only
    // needed for the transcription enqueue, so look it up by externalId.
    const created = await db.groundMessages.findFirst({
      where: { groundSourceId: source.id, externalId },
      select: { id: true },
    });
    return {
      status: "created",
      groundMessageId: created?.id ?? "",
      threadId: thread.id,
      hasAudio,
    };
  } catch (err: unknown) {
    // P2002 on [groundSourceId, externalId]: a concurrent webhook retry
    // won the race — the idempotent outcome.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: unknown }).code === "P2002"
    ) {
      return { status: "duplicate" };
    }
    throw err;
  }
}

/** Celery task name for voice transcription. CONTRACT with clear-pipeline
 * (V3 work there): registered with the BARE name, like
 * classify_ground_messages — see services/ground-classify.ts. */
export const GROUND_TRANSCRIBE_TASK = "transcribe_ground_message";

/** Fire-and-forget, same rationale as enqueueGroundClassification: a
 * broker hiccup must never fail a persisted ingest; the message sits in
 * the review queue untranscribed and the task can be re-enqueued. */
export function enqueueGroundTranscription(groundMessageId: string): void {
  void sendCeleryTask(GROUND_TRANSCRIBE_TASK, { ground_message_id: groundMessageId }).catch(
    (err) => {
      console.warn(
        `[hotline-ingest] transcription enqueue failed for ${groundMessageId}:`,
        err instanceof Error ? err.message : err,
      );
    },
  );
}
