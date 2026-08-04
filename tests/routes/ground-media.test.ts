/**
 * Handler tests for the live ground-media byte-upload route: status
 * codes, machine auth gating, the hard consent gate (nothing stored on
 * rejection), and the returned content-hash key scheme — exactly as the
 * gateway mirror sees them over HTTP (fetch + FormData).
 *
 * Fully hermetic: `resolveRequestAuth`, the Prisma client module, and the
 * S3 service are vi.mock()ed — no database, no bucket, no network beyond
 * the throwaway local Express server. Fixtures synthetic.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Server } from "node:http";

const { resolveRequestAuthMock, prismaStub, uploadBufferToS3Mock, s3ObjectExistsMock } =
  vi.hoisted(() => {
    const sources: Array<Record<string, unknown>> = [];
    const messages: Array<{ id: string; groundSourceId: string; externalId: string; mediaKeys: string[] }> = [];
    const prismaStub = {
      __sources: sources,
      __messages: messages,
      groundSources: {
        findFirst: async ({
          where,
        }: {
          where: { id?: string; transportId?: string };
        }) =>
          sources.find(
            (s) =>
              (where.id !== undefined && s.id === where.id) ||
              (where.transportId !== undefined && s.transportId === where.transportId),
          ) ?? null,
      },
      groundMessages: {
        findFirst: async ({
          where,
        }: {
          where: { groundSourceId: string; externalId: string };
        }) => {
          const row = messages.find(
            (m) => m.groundSourceId === where.groundSourceId && m.externalId === where.externalId,
          );
          return row ? { id: row.id, mediaKeys: [...row.mediaKeys] } : null;
        },
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: { mediaKeys: string[] } }) => {
            const row = messages.find((m) => m.id === where.id);
            if (row) row.mediaKeys = data.mediaKeys;
            return row;
          },
        ),
      },
    };
    return {
      resolveRequestAuthMock: vi.fn(),
      prismaStub,
      uploadBufferToS3Mock: vi.fn(async (_buffer: Buffer, key: string) => key),
      s3ObjectExistsMock: vi.fn(async () => false),
    };
  });

vi.mock("../../src/utils/request-auth.js", () => ({
  resolveRequestAuth: resolveRequestAuthMock,
}));

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaStub }));

vi.mock("../../src/services/s3.js", () => ({
  uploadBufferToS3: uploadBufferToS3Mock,
  s3ObjectExists: s3ObjectExistsMock,
}));

import express from "express";
import { groundMediaRouter } from "../../src/routes/ground-media.js";

const CONSENTED_JID = "111000111@g.us";
const CONSENTED_SOURCE_ID = "gs_consented";

const MEDIA_BYTES = Buffer.from("synthetic-jpeg-bytes-for-ground-media-test");
const MEDIA_SHA256 = createHash("sha256").update(MEDIA_BYTES).digest("hex");
const EXPECTED_KEY = `ground/${CONSENTED_SOURCE_ID}/${MEDIA_SHA256}.jpg`;

function asPipeline() {
  resolveRequestAuthMock.mockResolvedValue({
    user: { id: "machine", role: "pipeline" },
    session: null,
    authMethod: "api-key",
  });
}

describe("POST /api/ground/media", () => {
  let server: Server;
  let url: string;

  function mediaForm(fields: Record<string, string>, withFile = true): FormData {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      form.append(name, value);
    }
    if (withFile) {
      form.append("file", new Blob([MEDIA_BYTES], { type: "image/jpeg" }), "IMG-0001.jpg");
    }
    return form;
  }

  async function post(form: FormData) {
    return fetch(url, { method: "POST", body: form });
  }

  beforeAll(async () => {
    const app = express();
    app.use("/api/ground/media", groundMediaRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/api/ground/media`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resolveRequestAuthMock.mockReset();
    uploadBufferToS3Mock.mockClear();
    s3ObjectExistsMock.mockClear();
    s3ObjectExistsMock.mockResolvedValue(false);
    prismaStub.groundMessages.update.mockClear();
    prismaStub.__messages.length = 0;
    prismaStub.__sources.length = 0;
    prismaStub.__sources.push({
      id: CONSENTED_SOURCE_ID,
      transportId: CONSENTED_JID,
      isActive: true,
      consentScope: "full_message_content",
      consentRecordedAt: new Date("2026-08-01T00:00:00Z"),
      consentRecordedBy: "Test Facilitator (synthetic)",
    });
  });

  it("401s an unauthenticated caller, storing nothing", async () => {
    resolveRequestAuthMock.mockResolvedValue({ user: null, session: null, authMethod: null });
    const res = await post(mediaForm({ groupJid: CONSENTED_JID }));
    expect(res.status).toBe(401);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
  });

  it("403s a non-machine role (analyst), storing nothing", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "u1", role: "analyst" },
      session: null,
      authMethod: "api-key",
    });
    const res = await post(mediaForm({ groupJid: CONSENTED_JID }));
    expect(res.status).toBe(403);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
  });

  it("400s when the file field is missing", async () => {
    asPipeline();
    const res = await post(mediaForm({ groupJid: CONSENTED_JID }, false));
    expect(res.status).toBe(400);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
  });

  it("400s when neither groundSourceId nor groupJid is given", async () => {
    asPipeline();
    const res = await post(mediaForm({}));
    expect(res.status).toBe(400);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
  });

  it("400s when BOTH groundSourceId and groupJid are given", async () => {
    asPipeline();
    const res = await post(
      mediaForm({ groundSourceId: CONSENTED_SOURCE_ID, groupJid: CONSENTED_JID }),
    );
    expect(res.status).toBe(400);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
  });

  it("403s AND logs an unknown group JID, storing nothing", async () => {
    asPipeline();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await post(mediaForm({ groupJid: "999000999@g.us" }));

    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toContain("no ground source registered");
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("consent gate rejected"),
      expect.stringContaining("no ground source registered"),
    );
    warnSpy.mockRestore();
  });

  it("403s a source whose consent does not cover message content, storing nothing", async () => {
    asPipeline();
    prismaStub.__sources.length = 0;
    prismaStub.__sources.push({
      id: "gs_links_only",
      transportId: CONSENTED_JID,
      isActive: true,
      consentScope: "links and resources only",
      consentRecordedAt: new Date("2026-08-01T00:00:00Z"),
      consentRecordedBy: "Test Facilitator (synthetic)",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await post(mediaForm({ groupJid: CONSENTED_JID }));

    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toContain("does not cover message-content capture");
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("stores an authenticated upload by groupJid and returns the content-hash key", async () => {
    asPipeline();
    const res = await post(mediaForm({ groupJid: CONSENTED_JID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      key: EXPECTED_KEY,
      groundSourceId: CONSENTED_SOURCE_ID,
      deduplicated: false,
      attached: false,
    });
    expect(uploadBufferToS3Mock).toHaveBeenCalledTimes(1);
    const [buffer, key, mimetype] = uploadBufferToS3Mock.mock.calls[0]!;
    expect(Buffer.compare(buffer, MEDIA_BYTES)).toBe(0);
    expect(key).toBe(EXPECTED_KEY);
    expect(mimetype).toBe("image/jpeg");
  });

  it("stores an authenticated upload by groundSourceId (admin caller)", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "a1", role: "admin" },
      session: null,
      authMethod: "session",
    });
    const res = await post(mediaForm({ groundSourceId: CONSENTED_SOURCE_ID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key).toBe(EXPECTED_KEY);
  });

  it("re-upload of identical bytes returns the same key, skips the PUT, reports deduplicated", async () => {
    asPipeline();
    s3ObjectExistsMock.mockResolvedValue(true); // same content-hash key already in S3
    const res = await post(mediaForm({ groupJid: CONSENTED_JID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; deduplicated: boolean };
    expect(body.key).toBe(EXPECTED_KEY);
    expect(body.deduplicated).toBe(true);
    // No duplicate S3 object is ever written for the same bytes.
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
  });

  it("message-then-media: appends the key to an already-ingested message's mediaKeys", async () => {
    asPipeline();
    const externalId = `whatsapp:${CONSENTED_JID}:MSG001`;
    prismaStub.__messages.push({
      id: "gm_1",
      groundSourceId: CONSENTED_SOURCE_ID,
      externalId,
      mediaKeys: [],
    });

    const res = await post(
      mediaForm({ groupJid: CONSENTED_JID, sourceMessageExternalId: externalId }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { attached: boolean };
    expect(body.attached).toBe(true);
    expect(prismaStub.__messages[0]!.mediaKeys).toEqual([EXPECTED_KEY]);
  });

  it("media-then-message: unknown externalId still stores and returns the key, attached false", async () => {
    asPipeline();
    const res = await post(
      mediaForm({
        groupJid: CONSENTED_JID,
        sourceMessageExternalId: `whatsapp:${CONSENTED_JID}:NOT_YET_INGESTED`,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; attached: boolean };
    expect(body.key).toBe(EXPECTED_KEY); // gateway carries it into the ingest payload
    expect(body.attached).toBe(false);
    expect(uploadBufferToS3Mock).toHaveBeenCalledTimes(1);
    expect(prismaStub.groundMessages.update).not.toHaveBeenCalled();
  });

  it("idempotent re-attach: a key already on the message is not appended twice", async () => {
    asPipeline();
    const externalId = `whatsapp:${CONSENTED_JID}:MSG001`;
    prismaStub.__messages.push({
      id: "gm_1",
      groundSourceId: CONSENTED_SOURCE_ID,
      externalId,
      mediaKeys: [EXPECTED_KEY],
    });
    s3ObjectExistsMock.mockResolvedValue(true);

    const res = await post(
      mediaForm({ groupJid: CONSENTED_JID, sourceMessageExternalId: externalId }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { attached: boolean; deduplicated: boolean };
    expect(body.attached).toBe(true);
    expect(body.deduplicated).toBe(true);
    expect(prismaStub.groundMessages.update).not.toHaveBeenCalled();
    expect(prismaStub.__messages[0]!.mediaKeys).toEqual([EXPECTED_KEY]);
  });

  it("attach scoping: an externalId under a DIFFERENT source is not attached", async () => {
    asPipeline();
    prismaStub.__messages.push({
      id: "gm_other",
      groundSourceId: "gs_other_source",
      externalId: `whatsapp:${CONSENTED_JID}:MSG001`,
      mediaKeys: [],
    });

    const res = await post(
      mediaForm({
        groupJid: CONSENTED_JID,
        sourceMessageExternalId: `whatsapp:${CONSENTED_JID}:MSG001`,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { attached: boolean };
    expect(body.attached).toBe(false);
    expect(prismaStub.__messages[0]!.mediaKeys).toEqual([]);
  });
});
