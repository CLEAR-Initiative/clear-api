/**
 * Ingestion of parsed WhatsApp export messages into the ground staging
 * tier (groundThreads + groundMessages).
 *
 * Responsibilities that live HERE (the storage boundary), not in the
 * parser or the route:
 *   - Phone-number redaction at persistence — raw text never reaches disk.
 *   - Uncertainty-marker extraction ("unconfirmed", "rumour") so the tag
 *     survives ingestion (PRD requirement).
 *   - Idempotency: externalIds are deterministic content hashes and
 *     [groundSourceId, externalId] is unique, so re-uploading the same
 *     export creates zero duplicates. Existing ids are skipped up front;
 *     a concurrent-writer race falls back to the DB constraint.
 *   - Placeholder threads: V1 creates one thread per message
 *     (reviewState "unverified", lifecycleState "reported"). The
 *     clear-pipeline threading task (separate ticket) replaces these with
 *     real incident clustering.
 *
 * The DB surface is a narrow structural interface so tests can drive the
 * ingest logic with an in-memory stub (no test DB needed).
 */

import { createHash } from "node:crypto";
import {
  extractUncertaintyMarker,
  parseWhatsAppExport,
  redactPhoneNumbers,
  deriveSenderRef,
  withExternalIds,
} from "./whatsapp-export.js";

export interface GroundMessageCreate {
  groundSourceId: string;
  externalId: string;
  sentAt: Date;
  senderRef: string;
  /** Nullable because live capture (ground-live-ingest.ts) shares this
   * create shape and a sender may have no push name. Export parsing
   * always supplies one. */
  senderName: string | null;
  text: string;
  mediaKeys: string[];
  mediaRefs: string[];
  omittedMediaCount: number;
  uncertainty: string | null;
  isEdited: boolean;
}

/** Narrow structural view of the Prisma client used by ingestion. */
export interface GroundIngestDb {
  groundMessages: {
    findMany(args: {
      where: { groundSourceId: string; externalId: { in: string[] } };
      select: { externalId: true };
    }): Promise<Array<{ externalId: string }>>;
  };
  groundThreads: {
    create(args: {
      data: {
        groundSourceId: string;
        title: string;
        messages: { create: GroundMessageCreate };
      };
    }): Promise<{ id: string }>;
  };
}

export interface UploadedMediaFile {
  /** Original filename as referenced by the export's `<attached: …>`. */
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

/** Stores one attachment and returns its S3 key. Injected so tests (and
 * the route) control the S3 dependency. */
export type MediaStorer = (file: UploadedMediaFile, groundSourceId: string) => Promise<string>;

/**
 * Content-hash S3 key for a ground media attachment:
 *   ground/{groundSourceId}/{sha256}{.ext}
 * Deterministic in the bytes (same convention as sources/{sha256}.pdf in
 * routes/upload.ts), so re-uploading the same export's media overwrites
 * the same objects — no S3 duplicates on re-upload.
 */
export function groundMediaKey(
  groundSourceId: string,
  originalname: string,
  buffer: Buffer,
): string {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const dotIndex = originalname.lastIndexOf(".");
  const ext = dotIndex > 0 ? originalname.slice(dotIndex + 1).toLowerCase() : "";
  return `ground/${groundSourceId}/${sha256}${ext ? `.${ext}` : ""}`;
}

export interface IngestResult {
  /** groundMessages rows created by this call. */
  created: number;
  /** Messages skipped because their externalId already existed. */
  skipped: number;
  /** Attachment files stored to S3 by this call. */
  mediaStored: number;
  /** `<attached: …>` refs with no matching uploaded file. */
  mediaUnmatched: string[];
}

const THREAD_TITLE_MAX = 120;

/** Placeholder-thread title: first line of the redacted text, or a media
 * label for caption-less media messages. */
export function deriveThreadTitle(text: string, mediaRefs: string[], omitted: number): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine !== "") {
    return firstLine.length > THREAD_TITLE_MAX
      ? `${firstLine.slice(0, THREAD_TITLE_MAX - 1)}…`
      : firstLine;
  }
  if (mediaRefs.length > 0) return `[media] ${mediaRefs[0]}`;
  if (omitted > 0) return "[media] (not included in export)";
  return "(empty message)";
}

export async function ingestWhatsAppExport(options: {
  db: GroundIngestDb;
  groundSourceId: string;
  /** Transport binding of the source (WhatsApp group JID) — the
   * externalId scheme is "whatsapp:{groupJid}:{contentHash}". */
  groupJid: string;
  exportText: string;
  /** Attachment files uploaded alongside the chat .txt. Matched to
   * messages by the filename in their `<attached: …>` refs. */
  mediaFiles?: UploadedMediaFile[];
  /** Required when mediaFiles are provided. */
  storeMedia?: MediaStorer;
}): Promise<IngestResult> {
  const { db, groundSourceId, groupJid, exportText } = options;
  const mediaFiles = options.mediaFiles ?? [];

  const parsed = withExternalIds(groupJid, parseWhatsAppExport(exportText));
  if (parsed.length === 0) {
    return { created: 0, skipped: 0, mediaStored: 0, mediaUnmatched: [] };
  }

  const existing = await db.groundMessages.findMany({
    where: { groundSourceId, externalId: { in: parsed.map((m) => m.externalId) } },
    select: { externalId: true },
  });
  const existingIds = new Set(existing.map((row) => row.externalId));

  const filesByName = new Map(mediaFiles.map((f) => [f.originalname, f]));
  /** Content keys are deterministic, but store each distinct file once per call. */
  const storedKeys = new Map<string, string>();
  let mediaStored = 0;
  const mediaUnmatched: string[] = [];

  async function keysForRefs(refs: string[]): Promise<string[]> {
    const keys: string[] = [];
    for (const ref of refs) {
      const file = filesByName.get(ref);
      if (!file) {
        mediaUnmatched.push(ref);
        continue;
      }
      let key = storedKeys.get(ref);
      if (!key) {
        if (!options.storeMedia) {
          throw new Error("mediaFiles provided without a storeMedia implementation");
        }
        key = await options.storeMedia(file, groundSourceId);
        storedKeys.set(ref, key);
        mediaStored += 1;
      }
      keys.push(key);
    }
    return keys;
  }

  let created = 0;
  let skipped = 0;

  for (const message of parsed) {
    if (existingIds.has(message.externalId)) {
      skipped += 1;
      continue;
    }

    const text = redactPhoneNumbers(message.text);
    const mediaKeys = await keysForRefs(message.mediaRefs);

    const data: GroundMessageCreate = {
      groundSourceId,
      externalId: message.externalId,
      sentAt: message.sentAt,
      senderRef: deriveSenderRef(groundSourceId, message.senderName),
      senderName: message.senderName,
      text,
      mediaKeys,
      mediaRefs: message.mediaRefs,
      omittedMediaCount: message.omittedMediaCount,
      uncertainty: extractUncertaintyMarker(text),
      isEdited: message.isEdited,
    };

    try {
      // Nested create: the placeholder thread and its message land
      // atomically — a unique-violation on the message rolls back the
      // thread too, leaving no orphan.
      await db.groundThreads.create({
        data: {
          groundSourceId,
          title: deriveThreadTitle(text, message.mediaRefs, message.omittedMediaCount),
          messages: { create: data },
        },
      });
      created += 1;
    } catch (err: unknown) {
      // P2002 on [groundSourceId, externalId]: a concurrent upload of the
      // same export got there first. That is the idempotent outcome —
      // count it as skipped.
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

  return { created, skipped, mediaStored, mediaUnmatched };
}
