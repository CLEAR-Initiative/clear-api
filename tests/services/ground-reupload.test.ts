/**
 * Idempotent re-upload: re-ingesting the same export creates ZERO
 * duplicate groundMessages (ticket acceptance criterion).
 *
 * The mechanism under test: externalIds are deterministic content hashes
 * (whatsapp:{groupJid}:{contentHash}, occurrence-disambiguated), already
 * ingested ids are skipped up front, and a concurrent-writer race falls
 * back to the DB's unique [groundSourceId, externalId] constraint
 * (P2002 → counted as skipped, nested create leaves no orphan thread).
 *
 * Uses the same in-memory stub as ground-ingest.test.ts. Synthetic
 * fixture. No DB. Always runs. (The same property was verified against
 * a real Postgres in the Action 1/4 smoke runs.)
 */

import { describe, it, expect } from "vitest";
import {
  ingestWhatsAppExport,
  type GroundIngestDb,
  type GroundMessageCreate,
  type UploadedMediaFile,
} from "../../src/services/ground-ingest.js";

const LRM = "‎";
const NNBSP = " ";

function makeStubDb(options?: { raceOnFirstCreate?: boolean }) {
  const messages: GroundMessageCreate[] = [];
  const threadTitles: string[] = [];
  const byExternalId = new Set<string>();
  let raceArmed = options?.raceOnFirstCreate ?? false;

  const db: GroundIngestDb = {
    groundMessages: {
      findMany: async ({ where }) => {
        return messages
          .filter(
            (m) =>
              m.groundSourceId === where.groundSourceId &&
              where.externalId.in.includes(m.externalId),
          )
          .map((m) => ({ externalId: m.externalId }));
      },
    },
    groundThreads: {
      create: async ({ data }) => {
        const created = data.messages.create;
        const uniqueKey = `${created.groundSourceId}|${created.externalId}`;
        if (byExternalId.has(uniqueKey) || raceArmed) {
          // Simulates a concurrent upload winning the insert: the unique
          // constraint fires even though the up-front findMany saw nothing.
          raceArmed = false;
          if (!byExternalId.has(uniqueKey)) byExternalId.add(uniqueKey);
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        byExternalId.add(uniqueKey);
        messages.push(created);
        threadTitles.push(data.title);
        return { id: `thread_${threadTitles.length}` };
      },
    },
  };

  return { db, messages, threadTitles };
}

const EXPORT_V1 = [
  `[12.04.26, 07:21:00] ~${NNBSP}Basma: Strike reported at the water point in Kolme`,
  `[12.04.26, 07:35:00] ~${NNBSP}Basma: Correction - it was Dorti, not Kolme ${LRM}<This message was edited>`,
  `${LRM}[12.04.26, 08:00:00] Chris Sample: ${LRM}<attached: 00000009-PHOTO-2026-04-12.jpg>`,
  `${LRM}[12.04.26, 08:00:00] Chris Sample: ${LRM}<attached: 00000009-PHOTO-2026-04-12.jpg>`,
].join("\r\n");

// The same chat exported again later: identical history plus new messages
// (how WhatsApp exports actually behave — they always contain the full
// history from the export point backwards).
const EXPORT_V2 = [
  EXPORT_V1,
  `[13.04.26, 16:56:00] ~${NNBSP}Sarah Test: This turned out to be misreporting - no strikes at either location`,
].join("\r\n");

const PHOTO: UploadedMediaFile = {
  originalname: "00000009-PHOTO-2026-04-12.jpg",
  buffer: Buffer.from("synthetic jpeg"),
  mimetype: "image/jpeg",
};

describe("idempotent re-upload", () => {
  it("re-uploading the same export creates zero duplicates", async () => {
    const { db, messages, threadTitles } = makeStubDb();
    const args = {
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: EXPORT_V1,
    };

    const first = await ingestWhatsAppExport(args);
    expect(first).toMatchObject({ created: 4, skipped: 0 });

    const second = await ingestWhatsAppExport(args);
    expect(second).toMatchObject({ created: 0, skipped: 4 });

    // Zero duplicate messages AND zero extra placeholder threads.
    expect(messages).toHaveLength(4);
    expect(threadTitles).toHaveLength(4);
    expect(new Set(messages.map((m) => m.externalId)).size).toBe(4);
  });

  it("identical duplicate messages within one export both survive, still idempotently", async () => {
    // EXPORT_V1 lines 3+4 are byte-identical (burst-forwarded media) —
    // occurrence disambiguation gives them distinct stable ids.
    const { db, messages } = makeStubDb();
    const args = { db, groundSourceId: "src_1", groupJid: "jid@g.us", exportText: EXPORT_V1 };
    await ingestWhatsAppExport(args);
    await ingestWhatsAppExport(args);
    const dupes = messages.filter((m) => m.mediaRefs.includes(PHOTO.originalname));
    expect(dupes).toHaveLength(2);
  });

  it("an appended export only creates the new tail", async () => {
    const { db, messages } = makeStubDb();
    await ingestWhatsAppExport({
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: EXPORT_V1,
    });

    const result = await ingestWhatsAppExport({
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: EXPORT_V2,
    });

    expect(result).toMatchObject({ created: 1, skipped: 4 });
    expect(messages).toHaveLength(5);
    expect(messages[4]!.text).toContain("misreporting");
  });

  it("re-upload with media does not re-store attachments for skipped messages", async () => {
    const { db } = makeStubDb();
    const storeCalls: string[] = [];
    const storer = async (file: UploadedMediaFile) => {
      storeCalls.push(file.originalname);
      return `ground/src_1/stub-${file.originalname}`;
    };
    const args = {
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: EXPORT_V1,
      mediaFiles: [PHOTO],
      storeMedia: storer,
    };

    await ingestWhatsAppExport(args);
    expect(storeCalls).toHaveLength(1); // stored once, reused for the duplicate message

    await ingestWhatsAppExport(args);
    expect(storeCalls).toHaveLength(1); // nothing new to store on re-upload
  });

  it("a concurrent-writer race on insert is absorbed as a skip, not an error", async () => {
    const { db, messages } = makeStubDb({ raceOnFirstCreate: true });
    const result = await ingestWhatsAppExport({
      db,
      groundSourceId: "src_1",
      groupJid: "jid@g.us",
      exportText: EXPORT_V1,
    });
    // First insert lost the race (P2002) → skipped; the rest created.
    expect(result).toMatchObject({ created: 3, skipped: 1 });
    expect(messages).toHaveLength(3);
  });

  it("different sources ingest the same export independently", async () => {
    const { db, messages } = makeStubDb();
    await ingestWhatsAppExport({
      db,
      groundSourceId: "src_1",
      groupJid: "jid-a@g.us",
      exportText: EXPORT_V1,
    });
    const other = await ingestWhatsAppExport({
      db,
      groundSourceId: "src_2",
      groupJid: "jid-b@g.us",
      exportText: EXPORT_V1,
    });
    expect(other).toMatchObject({ created: 4, skipped: 0 });
    expect(messages).toHaveLength(8);
  });
});
