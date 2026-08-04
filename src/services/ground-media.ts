/**
 * Live-capture media storage for the ground staging tier: the gateway
 * mirror (mastra WhatsApp gateway) downloads media bytes from WhatsApp
 * and POSTs them here; we store them to S3 under the SAME content-hash
 * key scheme as chat-export attachments (`ground/{sourceId}/{sha256}.{ext}`,
 * services/ground-ingest.ts#groundMediaKey), so identical bytes never
 * create duplicate S3 objects regardless of how many times or from which
 * path they arrive.
 *
 * THE CONSENT GATE IS HARD, exactly like live message ingest
 * (services/ground-live-ingest.ts): media is only stored for an ACTIVE
 * groundSources row whose recorded consent covers message-content
 * capture. Unknown source or unconsented scope → rejection with NOTHING
 * stored (PRD V2 constraint).
 *
 * The DB and S3 surfaces are narrow structural interfaces so tests drive
 * the whole gate + storage + attach logic hermetically (no DB, no bucket).
 */

import {
  consentCoversMessageContent,
  type ConsentPolicyRow,
} from "./ground-live-ingest.js";
import { groundMediaKey } from "./ground-ingest.js";

export interface GroundMediaDb {
  groundSources: {
    findFirst(args: {
      where: { id?: string; transportId?: string };
    }): Promise<ConsentPolicyRow | null>;
  };
}

export interface GroundMediaFile {
  /** Original attachment filename — its extension ends up in the S3 key. */
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

export type StoreGroundMediaResult =
  | {
      /** Consent gate failed — NOTHING was stored. */
      ok: false;
      reason: string;
    }
  | {
      ok: true;
      /** Content-hash S3 key: ground/{groundSourceId}/{sha256}.{ext}. */
      key: string;
      groundSourceId: string;
    };

/**
 * Store one media file for a ground source, consent-gated.
 *
 * The source is resolved by `groundSourceId` OR by `groupJid` (the
 * WhatsApp group JID, i.e. the groundSources transportId) — the gateway
 * caller natively knows JIDs (its ingest payloads are JID-keyed), while
 * admin/manual callers may hold the row id. Exactly one must be given;
 * the route validates that.
 */
export async function storeGroundMedia(options: {
  db: GroundMediaDb;
  groundSourceId?: string | null;
  groupJid?: string | null;
  file: GroundMediaFile;
  /** Stores bytes under the given key and returns the key. Injected so
   * tests (and the route) control the S3 dependency. */
  storeObject: (buffer: Buffer, key: string, mimetype: string) => Promise<string>;
}): Promise<StoreGroundMediaResult> {
  const { db, file } = options;

  // ── Consent gate (before ANY storage) ────────────────────────────────
  const where = options.groundSourceId
    ? { id: options.groundSourceId }
    : { transportId: options.groupJid ?? "" };
  const source = await db.groundSources.findFirst({ where });
  if (!source) {
    return { ok: false, reason: "no ground source registered for this id/JID" };
  }
  const verdict = consentCoversMessageContent(source);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason };
  }

  // ── Storage under the content-hash key ───────────────────────────────
  const key = groundMediaKey(source.id, file.originalname, file.buffer);
  await options.storeObject(file.buffer, key, file.mimetype);

  return { ok: true, key, groundSourceId: source.id };
}
