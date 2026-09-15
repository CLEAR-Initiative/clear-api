/**
 * Hotline ingest tests: the gate (kind + active, NOT consent scope), the
 * anonymity guarantees the ticket makes non-negotiable (no senderName,
 * keyed per-conversation pseudonym, no raw handle anywhere), redaction,
 * MessageSid idempotency, media ordering (gate → dedupe → fetch), voice
 * detection, and the transcription-enqueue contract. Hermetic: in-memory
 * DB stub, injected storeMedia, mocked celery.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendCeleryTaskMock } = vi.hoisted(() => ({
  sendCeleryTaskMock: vi.fn(),
}));

vi.mock("../../src/services/celery.js", () => ({
  sendCeleryTask: sendCeleryTaskMock,
}));

import {
  resolveHotlineSource,
  ingestHotlineMessage,
  hotlinePseudonym,
  hotlineExternalId,
  enqueueGroundTranscription,
  GROUND_TRANSCRIBE_TASK,
  type HotlineIngestDb,
  type HotlineInboundMessage,
  type HotlineSourceRow,
} from "../../src/services/hotline-ingest.js";

const HOTLINE_NUMBER = "+14155238886";
const SECRET = "test-secret-at-least-16-chars";
const REPORTER = "whatsapp:+249111222333";

interface StoredThread {
  id: string;
  messageId: string;
  title: string;
  message: Record<string, unknown>;
}

/** In-memory HotlineIngestDb with one configurable source row. */
function makeDb(source: HotlineSourceRow | null) {
  const threads: StoredThread[] = [];
  let nextId = 1;
  const db: HotlineIngestDb = {
    groundSources: {
      findFirst: async ({ where }) =>
        source && source.transportId === where.transportId ? source : null,
    },
    groundMessages: {
      findFirst: async ({ where }) => {
        const hit = threads.find(
          (t) =>
            t.message.groundSourceId === where.groundSourceId &&
            t.message.externalId === where.externalId,
        );
        return hit
          ? { id: hit.messageId, threadId: hit.id, mediaKeys: hit.message.mediaKeys as string[] }
          : null;
      },
      update: async ({ where, data }) => {
        const hit = threads.find((t) => t.messageId === where.id);
        if (!hit) throw new Error(`no message ${where.id}`);
        hit.message.mediaKeys = data.mediaKeys;
        return hit.message;
      },
    },
    groundThreads: {
      create: async ({ data }) => {
        const n = nextId++;
        const id = `t${n}`;
        const messageId = `m${n}`;
        threads.push({ id, messageId, title: data.title, message: { ...data.messages.create } });
        return { id, messages: [{ id: messageId }] };
      },
    },
  };
  return { db, threads };
}

const ACTIVE_HOTLINE: HotlineSourceRow = {
  id: "gs_hotline",
  kind: "hotline",
  transportId: HOTLINE_NUMBER,
  isActive: true,
};

function textMessage(overrides: Partial<HotlineInboundMessage> = {}): HotlineInboundMessage {
  return {
    messageId: "SM001",
    senderHandle: REPORTER,
    sentAt: new Date("2026-08-18T09:00:00.000Z"),
    text: "Attack on the village this morning, unconfirmed.",
    media: [],
    ...overrides,
  };
}

describe("resolveHotlineSource", () => {
  it("accepts an active hotline source", async () => {
    const { db } = makeDb(ACTIVE_HOTLINE);
    const result = await resolveHotlineSource(db, HOTLINE_NUMBER);
    expect(result).toEqual({ ok: true, source: ACTIVE_HOTLINE });
  });

  it("rejects an unregistered number", async () => {
    const { db } = makeDb(null);
    const result = await resolveHotlineSource(db, HOTLINE_NUMBER);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("no ground source") });
  });

  it("rejects a source of a non-hotline kind (a group JID can never take hotline traffic)", async () => {
    const { db } = makeDb({ ...ACTIVE_HOTLINE, kind: "staff_group" });
    const result = await resolveHotlineSource(db, HOTLINE_NUMBER);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("staff_group") });
  });

  it("rejects a deactivated hotline", async () => {
    const { db } = makeDb({ ...ACTIVE_HOTLINE, isActive: false });
    const result = await resolveHotlineSource(db, HOTLINE_NUMBER);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("deactivated") });
  });
});

describe("hotlinePseudonym", () => {
  it("is stable per (secret, hotline, sender) and prefixed h_", () => {
    const a = hotlinePseudonym(SECRET, HOTLINE_NUMBER, REPORTER);
    expect(a).toMatch(/^h_[0-9a-f]{12}$/);
    expect(hotlinePseudonym(SECRET, HOTLINE_NUMBER, REPORTER)).toBe(a);
  });

  it("differs per sender and per secret (keyed, not a bare hash)", () => {
    const a = hotlinePseudonym(SECRET, HOTLINE_NUMBER, REPORTER);
    expect(hotlinePseudonym(SECRET, HOTLINE_NUMBER, "whatsapp:+249999888777")).not.toBe(a);
    expect(hotlinePseudonym("another-secret-16-chars!", HOTLINE_NUMBER, REPORTER)).not.toBe(a);
  });
});

describe("ingestHotlineMessage", () => {
  const storeMediaMock = vi.fn();

  beforeEach(() => {
    storeMediaMock.mockReset();
    storeMediaMock.mockImplementation(async (_media, index) => `ground/gs_hotline/key-${index}`);
  });

  function ingest(db: HotlineIngestDb, message: HotlineInboundMessage) {
    return ingestHotlineMessage({
      db,
      source: ACTIVE_HOTLINE,
      message,
      pseudonymSecret: SECRET,
      storeMedia: storeMediaMock,
    });
  }

  it("creates a message + placeholder thread with hotline anonymity", async () => {
    const { db, threads } = makeDb(ACTIVE_HOTLINE);
    const result = await ingest(db, textMessage());

    expect(result.status).toBe("created");
    expect(threads).toHaveLength(1);
    const message = threads[0].message;

    // Anonymity: no display name, keyed pseudonym, no raw handle anywhere.
    expect(message.senderName).toBeNull();
    expect(message.senderRef).toBe(hotlinePseudonym(SECRET, HOTLINE_NUMBER, REPORTER));
    expect(JSON.stringify(message)).not.toContain("+249111222333");

    expect(message.externalId).toBe(hotlineExternalId(HOTLINE_NUMBER, "SM001"));
    expect(message.uncertainty).toBe("unconfirmed");
  });

  it("redacts phone numbers in the text at persistence", async () => {
    const { db, threads } = makeDb(ACTIVE_HOTLINE);
    await ingest(db, textMessage({ text: "Call me back on +249 91 234 5678 please" }));

    const text = threads[0].message.text as string;
    expect(text).not.toContain("+249 91 234 5678");
    expect(text).toContain("[phone redacted]");
  });

  it("skips a duplicate MessageSid without touching media (idempotent webhook retry)", async () => {
    const { db, threads } = makeDb(ACTIVE_HOTLINE);
    const withMedia = textMessage({
      media: [{ url: "https://api.twilio.com/media/1", contentType: "image/jpeg" }],
    });

    expect((await ingest(db, withMedia)).status).toBe("created");
    expect(storeMediaMock).toHaveBeenCalledTimes(1);

    expect((await ingest(db, withMedia)).status).toBe("duplicate");
    expect(threads).toHaveLength(1);
    // Dedupe happens BEFORE the media fetch — a retry must not re-download.
    expect(storeMediaMock).toHaveBeenCalledTimes(1);
  });

  it("treats a concurrent-writer unique violation as a duplicate", async () => {
    const { db } = makeDb(ACTIVE_HOTLINE);
    db.groundThreads.create = async () => {
      throw Object.assign(new Error("unique violation"), { code: "P2002" });
    };
    expect((await ingest(db, textMessage())).status).toBe("duplicate");
  });

  it("stores media keys and flags audio for transcription", async () => {
    const { db, threads } = makeDb(ACTIVE_HOTLINE);
    const result = await ingest(
      db,
      textMessage({
        text: null,
        media: [
          { url: "https://api.twilio.com/media/1", contentType: "audio/ogg" },
          { url: "https://api.twilio.com/media/2", contentType: "image/jpeg" },
        ],
      }),
    );

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.hasAudio).toBe(true);
    // The id comes back from the nested create itself, not a re-lookup.
    expect(result.groundMessageId).toBe("m1");

    const message = threads[0].message;
    expect(message.mediaKeys).toEqual(["ground/gs_hotline/key-0", "ground/gs_hotline/key-1"]);
    // Caption-less media must still become a signal (PRD requirement).
    expect(message.text).toBe("");
    expect(threads[0].title).toBe("[media] voice-0");
  });

  it("persists the row BEFORE media, so a media failure leaves a retrievable message", async () => {
    const { db, threads } = makeDb(ACTIVE_HOTLINE);
    storeMediaMock.mockRejectedValue(new Error("twilio media edge timed out"));
    const withVoice = textMessage({
      text: "Voice note attached",
      media: [{ url: "https://api.twilio.com/media/1", contentType: "audio/ogg" }],
    });

    await expect(ingest(db, withVoice)).rejects.toThrow("timed out");
    // The message survived the media failure — no lost hotline report.
    expect(threads).toHaveLength(1);
    expect(threads[0].message.mediaKeys).toEqual([]);
    expect(threads[0].message.mediaRefs).toEqual(["voice-0"]);
  });

  it("backfills media on a retry after a media failure, without a second row", async () => {
    const { db, threads } = makeDb(ACTIVE_HOTLINE);
    const withVoice = textMessage({
      media: [{ url: "https://api.twilio.com/media/1", contentType: "audio/ogg" }],
    });
    storeMediaMock.mockRejectedValueOnce(new Error("S3 unavailable"));
    await expect(ingest(db, withVoice)).rejects.toThrow("S3 unavailable");

    const retry = await ingest(db, withVoice);
    expect(retry.status).toBe("media_backfilled");
    if (retry.status !== "media_backfilled") return;
    // Same row, same id the first attempt created — the caller enqueues on this.
    expect(retry.groundMessageId).toBe("m1");
    expect(retry.threadId).toBe("t1");
    expect(retry.hasAudio).toBe(true);
    expect(threads).toHaveLength(1);
    expect(threads[0].message.mediaKeys).toEqual(["ground/gs_hotline/key-0"]);

    // And once media has landed, a further retry is a plain duplicate.
    expect((await ingest(db, withVoice)).status).toBe("duplicate");
    expect(storeMediaMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat a media-less duplicate as a backfill candidate", async () => {
    const { db } = makeDb(ACTIVE_HOTLINE);
    expect((await ingest(db, textMessage())).status).toBe("created");
    expect((await ingest(db, textMessage())).status).toBe("duplicate");
    expect(storeMediaMock).not.toHaveBeenCalled();
  });

  it("reports hasAudio false for a text-only submission", async () => {
    const { db } = makeDb(ACTIVE_HOTLINE);
    const result = await ingest(db, textMessage());
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.hasAudio).toBe(false);
  });
});

describe("enqueueGroundTranscription", () => {
  beforeEach(() => {
    sendCeleryTaskMock.mockReset();
    sendCeleryTaskMock.mockResolvedValue("task-id");
  });

  it("enqueues transcribe_ground_message with ground_message_id kwargs", () => {
    enqueueGroundTranscription("gm_1");

    expect(sendCeleryTaskMock).toHaveBeenCalledExactlyOnceWith(GROUND_TRANSCRIBE_TASK, {
      ground_message_id: "gm_1",
    });
    // CONTRACT PIN: clear-pipeline must register @app.task(name="transcribe_ground_message")
    // — the bare name, like classify_ground_messages. Do not change one side alone.
    expect(GROUND_TRANSCRIBE_TASK).toBe("transcribe_ground_message");
  });

  it("swallows broker failures with a warning (fire-and-forget)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendCeleryTaskMock.mockRejectedValue(new Error("broker down"));

    enqueueGroundTranscription("gm_1");
    await new Promise((resolve) => setImmediate(resolve));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("transcription enqueue failed for gm_1"),
      "broker down",
    );
    warnSpy.mockRestore();
  });
});
