/**
 * Ingest-service tests: media handling and persistence rules.
 *
 * Uses an in-memory stub of the narrow GroundIngestDb surface plus an
 * injected media storer, so the persistence rules (redaction at the
 * storage boundary, caption-less media rows, content-hash media keys,
 * unmatched-ref reporting) are tested without a database or S3.
 * Fixture content is synthetic. Pure unit tests — always run.
 *
 * Idempotent re-upload behaviour has its own suite in
 * tests/services/ground-reupload.test.ts.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  groundMediaKey,
  ingestWhatsAppExport,
  deriveThreadTitle,
  type GroundIngestDb,
  type GroundMessageCreate,
  type UploadedMediaFile,
} from "../../src/services/ground-ingest.js";

const LRM = "‎";
const NNBSP = " ";

interface StoredThread {
  id: string;
  groundSourceId: string;
  title: string;
  message: GroundMessageCreate;
}

/** In-memory stub honouring the [groundSourceId, externalId] unique rule. */
function makeStubDb() {
  const threads: StoredThread[] = [];
  const byExternalId = new Set<string>();
  let nextId = 1;

  const db: GroundIngestDb = {
    groundMessages: {
      findMany: async ({ where }) => {
        return [...byExternalId]
          .filter(
            (key) =>
              key.startsWith(`${where.groundSourceId}|`) &&
              where.externalId.in.includes(key.split("|")[1]!),
          )
          .map((key) => ({ externalId: key.split("|")[1]! }));
      },
    },
    groundThreads: {
      create: async ({ data }) => {
        const uniqueKey = `${data.messages.create.groundSourceId}|${data.messages.create.externalId}`;
        if (byExternalId.has(uniqueKey)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        byExternalId.add(uniqueKey);
        const thread: StoredThread = {
          id: `thread_${nextId++}`,
          groundSourceId: data.groundSourceId,
          title: data.title,
          message: data.messages.create,
        };
        threads.push(thread);
        return { id: thread.id };
      },
    },
  };

  return { db, threads };
}

function stubStorer(): { storer: (f: UploadedMediaFile, sourceId: string) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    storer: async (file, sourceId) => {
      calls.push(file.originalname);
      return groundMediaKey(sourceId, file.originalname, file.buffer);
    },
  };
}

const FIXTURE = [
  `[02.04.26, 07:15:00] ~${NNBSP}Basma: Strike reported near the market, call +249 91 234 5678 for details`,
  `${LRM}[03.04.26, 11:00:00] Chris Sample: Assessment attached ${LRM}<attached: 00000001-assessment.pdf>`,
  `${LRM}[03.04.26, 11:00:30] Chris Sample: ${LRM}<attached: 00000002-PHOTO-2026-04-03.jpg>`,
  `${LRM}[03.04.26, 11:01:00] ~${NNBSP}Basma: ${LRM}image omitted`,
].join("\r\n");

const PDF = { originalname: "00000001-assessment.pdf", buffer: Buffer.from("%PDF synthetic"), mimetype: "application/pdf" };
const PHOTO = { originalname: "00000002-PHOTO-2026-04-03.jpg", buffer: Buffer.from("jpeg synthetic bytes"), mimetype: "image/jpeg" };

describe("groundMediaKey", () => {
  it("is a content hash under the source's prefix, keeping the extension", () => {
    const key = groundMediaKey("src_1", "00000002-PHOTO-2026-04-03.jpg", PHOTO.buffer);
    const sha = createHash("sha256").update(PHOTO.buffer).digest("hex");
    expect(key).toBe(`ground/src_1/${sha}.jpg`);
  });

  it("is deterministic in the bytes — re-upload maps to the same object", () => {
    const a = groundMediaKey("src_1", "a.jpg", Buffer.from("same"));
    const b = groundMediaKey("src_1", "b-renamed.jpg", Buffer.from("same"));
    expect(a).toBe(b);
  });
});

describe("ingestWhatsAppExport — media handling", () => {
  it("stores matched attachments and records their keys on the message", async () => {
    const { db, threads } = makeStubDb();
    const { storer, calls } = stubStorer();

    const result = await ingestWhatsAppExport({
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: FIXTURE,
      mediaFiles: [PDF, PHOTO],
      storeMedia: storer,
    });

    expect(result.created).toBe(4);
    expect(result.mediaStored).toBe(2);
    expect(result.mediaUnmatched).toEqual([]);
    expect(calls.sort()).toEqual([PDF.originalname, PHOTO.originalname].sort());

    const captioned = threads[1]!.message;
    expect(captioned.text).toBe("Assessment attached");
    expect(captioned.mediaKeys).toEqual([
      groundMediaKey("src_1", PDF.originalname, PDF.buffer),
    ]);
  });

  it("caption-less attached media still becomes a row, with its key", async () => {
    const { db, threads } = makeStubDb();
    const { storer } = stubStorer();

    await ingestWhatsAppExport({
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: FIXTURE,
      mediaFiles: [PDF, PHOTO],
      storeMedia: storer,
    });

    const captionless = threads[2]!.message;
    expect(captionless.text).toBe("");
    expect(captionless.mediaKeys).toEqual([
      groundMediaKey("src_1", PHOTO.originalname, PHOTO.buffer),
    ]);
    expect(threads[2]!.title).toBe(`[media] ${PHOTO.originalname}`);
  });

  it("caption-less omitted media (file not in export) still becomes a row", async () => {
    const { db, threads } = makeStubDb();

    await ingestWhatsAppExport({
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: FIXTURE,
      // No media files at all — text-first ingest.
    });

    const omitted = threads[3]!.message;
    expect(omitted.text).toBe("");
    expect(omitted.omittedMediaCount).toBe(1);
    expect(omitted.mediaKeys).toEqual([]);
    expect(threads[3]!.title).toBe("[media] (not included in export)");
  });

  it("reports unmatched attachment refs without failing the ingest", async () => {
    const { db } = makeStubDb();
    const { storer } = stubStorer();

    const result = await ingestWhatsAppExport({
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: FIXTURE,
      mediaFiles: [PDF], // photo missing
      storeMedia: storer,
    });

    expect(result.created).toBe(4);
    expect(result.mediaStored).toBe(1);
    expect(result.mediaUnmatched).toEqual([PHOTO.originalname]);
  });

  it("redacts phone numbers at persistence", async () => {
    const { db, threads } = makeStubDb();

    await ingestWhatsAppExport({
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: FIXTURE,
    });

    expect(threads[0]!.message.text).toBe(
      "Strike reported near the market, call [phone redacted] for details",
    );
  });
});

describe("deriveThreadTitle", () => {
  it("uses the first line, truncated", () => {
    expect(deriveThreadTitle("short report\nsecond line", [], 0)).toBe("short report");
    const long = "x".repeat(200);
    expect(deriveThreadTitle(long, [], 0)).toHaveLength(120);
  });
});
