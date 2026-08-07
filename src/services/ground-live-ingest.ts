/**
 * Live-capture ingestion into the ground staging tier: gateway message
 * payloads (mastra WhatsApp gateway → clear-api mirror, V2 of the
 * WhatsApp Signal Pipeline PRD) land in the SAME normalized shape as
 * chat-export uploads — redaction at persistence, uncertainty-marker
 * extraction, placeholder thread per message, idempotent externalIds.
 *
 * What is different from the export path (services/ground-ingest.ts):
 *   - externalId is "whatsapp:{groupJid}:{messageId}" with the REAL
 *     upstream message id — live capture has one, exports don't (they
 *     content-hash instead). Both live under the same
 *     [groundSourceId, externalId] unique constraint, so replayed
 *     gateway deliveries create zero duplicates.
 *   - senderRef is derived from the sender's JID, not the display name:
 *     the JID is the stable WhatsApp identity, while push names change
 *     freely. The raw sender JID is a phone number and is therefore
 *     NEVER persisted — it exists only inside the sha256 that produces
 *     the pseudonymous ref. (Export-derived refs hash the display name;
 *     the two paths intentionally do not collide.)
 *   - THE CONSENT GATE IS HARD. Export upload trusts the human uploader
 *     to have checked the source's policy record; live capture is
 *     unattended, so every payload is judged against the groundSources
 *     row for its group JID and rejected outright — nothing persisted,
 *     rejection logged by the route — unless recorded consent covers
 *     message-content capture (PRD V2 constraint: "While a group has no
 *     recorded consent scope covering message-content capture, the
 *     system shall not ingest live messages from that group").
 *
 * The DB surface is a narrow structural interface so tests drive the
 * whole gate + normalization with an in-memory stub (no test DB).
 */

import {
  extractUncertaintyMarker,
  redactPhoneNumbers,
  deriveSenderRef,
} from "./whatsapp-export.js";
import {
  deriveThreadTitle,
  type GroundIngestDb,
  type GroundMessageCreate,
} from "./ground-ingest.js";

/** One captured gateway message, as posted by the live transport. */
export interface LiveIngestMessage {
  /** WhatsApp group JID the message was captured from ("…@g.us"). */
  groupJid: string;
  /** Upstream WhatsApp message id — unique per group, stable on replay. */
  messageId: string;
  /** Sender's WhatsApp JID. Hashed into senderRef, never persisted. */
  senderJid: string;
  /** Sender's display (push) name. Private tier only. */
  senderName?: string | null;
  /** Message timestamp, ISO 8601. */
  timestamp: string;
  /** Message text / media caption. Absent for caption-less media. */
  text?: string | null;
  /** S3 keys of media the gateway already stored (gateway-side download
   * is separate V2 work — empty until then). */
  mediaKeys?: string[];
  /** Original attachment filenames, when known. */
  mediaRefs?: string[];
  isEdited?: boolean;
}

/** The slice of a groundSources row the consent gate judges. */
export interface ConsentPolicyRow {
  id: string;
  transportId: string;
  isActive: boolean;
  consentScope: string | null;
  consentRecordedAt: Date | null;
  consentRecordedBy: string | null;
}

export interface GroundLiveIngestDb extends GroundIngestDb {
  groundSources: {
    findMany(args: {
      where: { transportId: { in: string[] } };
    }): Promise<ConsentPolicyRow[]>;
  };
}

/**
 * Consent scopes that cover message-content capture, compared after
 * normalization (lowercased, non-alphanumerics collapsed to "_"), so the
 * recorded free text "Full message content" passes and "links and
 * resources only" — the HSS DAO group's actual recorded scope — does not.
 * Deliberately an allowlist: an unrecognized scope fails CLOSED.
 */
export const CONTENT_CONSENT_SCOPES: ReadonlySet<string> = new Set([
  "full_message_content",
  "message_content",
  "full_content",
]);

export function normalizeConsentScope(scope: string): string {
  return scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export type ConsentVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Does this source's recorded consent cover live message-content capture?
 * Requires, in order: an active source, a recorded consent (scope text +
 * date + consenter — the policy record must say who consented and when,
 * not just what), and a scope that covers message content.
 */
export function consentCoversMessageContent(source: ConsentPolicyRow): ConsentVerdict {
  if (!source.isActive) {
    return { ok: false, reason: "ground source is deactivated" };
  }
  if (!source.consentScope || !source.consentRecordedAt || !source.consentRecordedBy) {
    return {
      ok: false,
      reason: "no fully recorded consent (scope, recorded date, and consenter are required)",
    };
  }
  if (!CONTENT_CONSENT_SCOPES.has(normalizeConsentScope(source.consentScope))) {
    return {
      ok: false,
      reason: `consent scope "${source.consentScope}" does not cover message-content capture`,
    };
  }
  return { ok: true };
}

export interface ConsentRejection {
  groupJid: string;
  reason: string;
}

export type LiveIngestResult =
  | {
      /** Consent gate failed — NOTHING was persisted for any message. */
      ok: false;
      rejections: ConsentRejection[];
    }
  | {
      ok: true;
      created: number;
      skipped: number;
      /** Per-source created counts, for downstream enqueueing. */
      sources: Array<{ groundSourceId: string; created: number }>;
    };

export function liveExternalId(groupJid: string, messageId: string): string {
  return `whatsapp:${groupJid}:${messageId}`;
}

/**
 * Ingest a batch of live gateway messages. All group JIDs in the batch
 * are consent-checked FIRST; a single unconsented JID rejects the whole
 * payload with nothing persisted (the transport must not learn that
 * partial smuggling works). Consented messages then follow the export
 * path's persistence rules exactly.
 */
export async function ingestLiveMessages(options: {
  db: GroundLiveIngestDb;
  messages: LiveIngestMessage[];
}): Promise<LiveIngestResult> {
  const { db, messages } = options;
  if (messages.length === 0) {
    return { ok: true, created: 0, skipped: 0, sources: [] };
  }

  // ── Consent gate ─────────────────────────────────────────────────────
  const jids = [...new Set(messages.map((m) => m.groupJid))];
  const sources = await db.groundSources.findMany({
    where: { transportId: { in: jids } },
  });
  const sourceByJid = new Map(sources.map((s) => [s.transportId, s]));

  const rejections: ConsentRejection[] = [];
  for (const jid of jids) {
    const source = sourceByJid.get(jid);
    if (!source) {
      rejections.push({ groupJid: jid, reason: "no ground source registered for this JID" });
      continue;
    }
    const verdict = consentCoversMessageContent(source);
    if (!verdict.ok) rejections.push({ groupJid: jid, reason: verdict.reason });
  }
  if (rejections.length > 0) {
    return { ok: false, rejections };
  }

  // ── Persistence, per source (same rules as the export path) ──────────
  let created = 0;
  let skipped = 0;
  const perSource: Array<{ groundSourceId: string; created: number }> = [];

  for (const jid of jids) {
    const source = sourceByJid.get(jid)!;
    const batch = messages.filter((m) => m.groupJid === jid);

    const externalIds = batch.map((m) => liveExternalId(jid, m.messageId));
    const existing = await db.groundMessages.findMany({
      where: { groundSourceId: source.id, externalId: { in: externalIds } },
      select: { externalId: true },
    });
    const existingIds = new Set(existing.map((row) => row.externalId));
    /** Also dedupes duplicate messageIds WITHIN one payload. */
    const seenInBatch = new Set<string>();

    let sourceCreated = 0;
    for (const message of batch) {
      const externalId = liveExternalId(jid, message.messageId);
      if (existingIds.has(externalId) || seenInBatch.has(externalId)) {
        skipped += 1;
        continue;
      }
      seenInBatch.add(externalId);

      const text = redactPhoneNumbers(message.text ?? "");
      const mediaRefs = message.mediaRefs ?? [];

      const data: GroundMessageCreate = {
        groundSourceId: source.id,
        externalId,
        sentAt: new Date(message.timestamp),
        senderRef: deriveSenderRef(source.id, message.senderJid),
        senderName: message.senderName ?? null,
        text,
        mediaKeys: message.mediaKeys ?? [],
        mediaRefs,
        omittedMediaCount: 0,
        uncertainty: extractUncertaintyMarker(text),
        isEdited: message.isEdited ?? false,
      };

      try {
        // Nested create — placeholder thread + message land atomically,
        // exactly like the export path. The clear-pipeline threading task
        // later replaces placeholders with real thread clustering.
        await db.groundThreads.create({
          data: {
            groundSourceId: source.id,
            title: deriveThreadTitle(text, mediaRefs, 0),
            messages: { create: data },
          },
        });
        created += 1;
        sourceCreated += 1;
      } catch (err: unknown) {
        // P2002 on [groundSourceId, externalId]: concurrent delivery of
        // the same message won the race — the idempotent outcome.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: unknown }).code === "P2002"
        ) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
    perSource.push({ groundSourceId: source.id, created: sourceCreated });
  }

  return { ok: true, created, skipped, sources: perSource };
}
