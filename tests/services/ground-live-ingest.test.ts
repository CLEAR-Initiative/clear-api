/**
 * Live-ingest service tests: the consent gate and the normalization /
 * persistence rules for gateway message payloads.
 *
 * Uses an in-memory stub of the narrow GroundLiveIngestDb surface (same
 * pattern as ground-ingest.test.ts), so the hard consent gate, redaction
 * at the storage boundary, externalId idempotency, and per-source result
 * accounting are tested without a database. Fixture content is entirely
 * synthetic — no real chat content, names, numbers, or JIDs.
 */

import { describe, it, expect } from "vitest";
import {
  CONTENT_CONSENT_SCOPES,
  consentCoversMessageContent,
  ingestLiveMessages,
  liveExternalId,
  normalizeConsentScope,
  type ConsentPolicyRow,
  type GroundLiveIngestDb,
  type LiveIngestMessage,
} from "../../src/services/ground-live-ingest.js";
import { type GroundMessageCreate } from "../../src/services/ground-ingest.js";
import { deriveSenderRef, PHONE_REDACTION_PLACEHOLDER } from "../../src/services/whatsapp-export.js";

const CONSENTED_JID = "111000111@g.us";
const LINKS_ONLY_JID = "222000222@g.us";
const UNKNOWN_JID = "999000999@g.us";

function consentedSource(overrides: Partial<ConsentPolicyRow> = {}): ConsentPolicyRow {
  return {
    id: "gs_consented",
    transportId: CONSENTED_JID,
    isActive: true,
    consentScope: "full_message_content",
    consentRecordedAt: new Date("2026-08-01T00:00:00Z"),
    consentRecordedBy: "Test Facilitator (synthetic)",
    ...overrides,
  };
}

interface StoredThread {
  id: string;
  groundSourceId: string;
  title: string;
  message: GroundMessageCreate;
}

/** In-memory stub honouring the [groundSourceId, externalId] unique rule. */
function makeStubDb(sources: ConsentPolicyRow[]) {
  const threads: StoredThread[] = [];
  const byExternalId = new Set<string>();
  let nextId = 1;

  const db: GroundLiveIngestDb = {
    groundSources: {
      findMany: async ({ where }) =>
        sources.filter((s) => where.transportId.in.includes(s.transportId)),
    },
    groundMessages: {
      findMany: async ({ where }) =>
        [...byExternalId]
          .filter(
            (key) =>
              key.startsWith(`${where.groundSourceId}|`) &&
              where.externalId.in.includes(key.split("|")[1]!),
          )
          .map((key) => ({ externalId: key.split("|")[1]! })),
    },
    groundThreads: {
      create: async ({ data }) => {
        const created = data.messages.create;
        const uniqueKey = `${created.groundSourceId}|${created.externalId}`;
        if (byExternalId.has(uniqueKey)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        byExternalId.add(uniqueKey);
        const thread: StoredThread = {
          id: `t${nextId++}`,
          groundSourceId: data.groundSourceId,
          title: data.title,
          message: created,
        };
        threads.push(thread);
        return { id: thread.id };
      },
    },
  };

  return { db, threads };
}

function message(overrides: Partial<LiveIngestMessage> = {}): LiveIngestMessage {
  return {
    groupJid: CONSENTED_JID,
    messageId: "MSG001",
    senderJid: "333000333@s.whatsapp.net",
    senderName: "Synthetic Sender",
    timestamp: "2026-08-04T10:00:00.000Z",
    text: "Synthetic report of a road closure near the test village.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Consent verdict
// ---------------------------------------------------------------------------

describe("consentCoversMessageContent", () => {
  it("accepts an active source with fully recorded content consent", () => {
    expect(consentCoversMessageContent(consentedSource())).toEqual({ ok: true });
  });

  it("accepts free-text scopes that normalize to a canonical content scope", () => {
    const verdict = consentCoversMessageContent(
      consentedSource({ consentScope: "Full message content" }),
    );
    expect(verdict.ok).toBe(true);
  });

  it('rejects the "links and resources only" scope', () => {
    const verdict = consentCoversMessageContent(
      consentedSource({ consentScope: "links and resources only" }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("does not cover message-content");
  });

  it("rejects a deactivated source even with content consent", () => {
    const verdict = consentCoversMessageContent(consentedSource({ isActive: false }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("deactivated");
  });

  it.each([
    ["missing scope", { consentScope: null }],
    ["missing recorded date", { consentRecordedAt: null }],
    ["missing consenter", { consentRecordedBy: null }],
  ] as const)("rejects when consent is not fully recorded (%s)", (_name, overrides) => {
    const verdict = consentCoversMessageContent(consentedSource(overrides));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("fully recorded consent");
  });

  it("fails closed on unrecognized scopes", () => {
    const verdict = consentCoversMessageContent(
      consentedSource({ consentScope: "everything, trust me" }),
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("normalizeConsentScope", () => {
  it("collapses case, whitespace and punctuation to underscores", () => {
    expect(normalizeConsentScope("  Full Message   Content! ")).toBe("full_message_content");
  });

  it("canonical set contains only normalized values", () => {
    for (const scope of CONTENT_CONSENT_SCOPES) {
      expect(normalizeConsentScope(scope)).toBe(scope);
    }
  });
});

// ---------------------------------------------------------------------------
// Consent gate at ingest
// ---------------------------------------------------------------------------

describe("ingestLiveMessages — consent gate", () => {
  it("rejects a payload whose JID has no ground source, persisting nothing", async () => {
    const { db, threads } = makeStubDb([consentedSource()]);
    const result = await ingestLiveMessages({
      db,
      messages: [message({ groupJid: UNKNOWN_JID })],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections).toEqual([
        { groupJid: UNKNOWN_JID, reason: "no ground source registered for this JID" },
      ]);
    }
    expect(threads).toHaveLength(0);
  });

  it("rejects a payload from a source whose consent covers links only", async () => {
    const { db, threads } = makeStubDb([
      consentedSource({
        id: "gs_links",
        transportId: LINKS_ONLY_JID,
        consentScope: "links and resources only",
      }),
    ]);
    const result = await ingestLiveMessages({
      db,
      messages: [message({ groupJid: LINKS_ONLY_JID })],
    });

    expect(result.ok).toBe(false);
    expect(threads).toHaveLength(0);
  });

  it("one unconsented JID rejects the WHOLE batch — consented messages are not smuggled in", async () => {
    const { db, threads } = makeStubDb([consentedSource()]);
    const result = await ingestLiveMessages({
      db,
      messages: [
        message(),
        message({ groupJid: UNKNOWN_JID, messageId: "MSG002" }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections.map((r) => r.groupJid)).toEqual([UNKNOWN_JID]);
    }
    expect(threads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence + normalization (consented path)
// ---------------------------------------------------------------------------

describe("ingestLiveMessages — normalization and persistence", () => {
  it("creates a groundMessage + placeholder thread with the export path's rules", async () => {
    const { db, threads } = makeStubDb([consentedSource()]);
    const result = await ingestLiveMessages({ db, messages: [message()] });

    expect(result).toMatchObject({ ok: true, created: 1, skipped: 0 });
    expect(threads).toHaveLength(1);

    const stored = threads[0]!.message;
    expect(stored.groundSourceId).toBe("gs_consented");
    expect(stored.externalId).toBe(`whatsapp:${CONSENTED_JID}:MSG001`);
    expect(stored.senderName).toBe("Synthetic Sender");
    expect(stored.sentAt.toISOString()).toBe("2026-08-04T10:00:00.000Z");
    expect(threads[0]!.title).toContain("Synthetic report");
  });

  it("redacts phone numbers at persistence and extracts uncertainty markers", async () => {
    const { db, threads } = makeStubDb([consentedSource()]);
    await ingestLiveMessages({
      db,
      messages: [
        message({
          text: "Unconfirmed: convoy seen, call +1 555 000 1111 for details",
        }),
      ],
    });

    const stored = threads[0]!.message;
    expect(stored.text).toContain(PHONE_REDACTION_PLACEHOLDER);
    expect(stored.text).not.toContain("555 000 1111");
    expect(stored.uncertainty).toBe("unconfirmed");
  });

  it("derives senderRef from the sender JID and never persists the JID itself", async () => {
    const { db, threads } = makeStubDb([consentedSource()]);
    const senderJid = "444000444@s.whatsapp.net";
    await ingestLiveMessages({ db, messages: [message({ senderJid })] });

    const stored = threads[0]!.message;
    expect(stored.senderRef).toBe(deriveSenderRef("gs_consented", senderJid));
    expect(stored.senderRef).toMatch(/^s_[0-9a-f]{12}$/);
    // The raw JID (a phone number) must not appear in any persisted field.
    expect(JSON.stringify(threads)).not.toContain(senderJid);
  });

  it("accepts caption-less media messages and stores their keys", async () => {
    const { db, threads } = makeStubDb([consentedSource()]);
    await ingestLiveMessages({
      db,
      messages: [
        message({
          text: null,
          mediaKeys: ["ground/gs_consented/abc123.jpg"],
          mediaRefs: ["IMG-0001.jpg"],
        }),
      ],
    });

    const stored = threads[0]!.message;
    expect(stored.text).toBe("");
    expect(stored.mediaKeys).toEqual(["ground/gs_consented/abc123.jpg"]);
    expect(threads[0]!.title).toBe("[media] IMG-0001.jpg");
  });

  it("is idempotent on redelivery: same messageId skips, never duplicates", async () => {
    const { db, threads } = makeStubDb([consentedSource()]);
    const first = await ingestLiveMessages({ db, messages: [message()] });
    const second = await ingestLiveMessages({ db, messages: [message()] });

    expect(first).toMatchObject({ ok: true, created: 1, skipped: 0 });
    expect(second).toMatchObject({ ok: true, created: 0, skipped: 1 });
    expect(threads).toHaveLength(1);
  });

  it("dedupes duplicate messageIds within one payload", async () => {
    const { db, threads } = makeStubDb([consentedSource()]);
    const result = await ingestLiveMessages({
      db,
      messages: [message(), message()],
    });

    expect(result).toMatchObject({ ok: true, created: 1, skipped: 1 });
    expect(threads).toHaveLength(1);
  });

  it("reports per-source created counts for a multi-group batch", async () => {
    const secondJid = "555000555@g.us";
    const { db } = makeStubDb([
      consentedSource(),
      consentedSource({ id: "gs_second", transportId: secondJid }),
    ]);
    const result = await ingestLiveMessages({
      db,
      messages: [
        message(),
        message({ messageId: "MSG002" }),
        message({ groupJid: secondJid, messageId: "MSG003" }),
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(3);
      expect(result.sources).toEqual([
        { groundSourceId: "gs_consented", created: 2 },
        { groundSourceId: "gs_second", created: 1 },
      ]);
    }
  });

  it("liveExternalId follows the whatsapp:{jid}:{messageId} scheme", () => {
    expect(liveExternalId("111@g.us", "ABC")).toBe("whatsapp:111@g.us:ABC");
  });
});
