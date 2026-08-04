/**
 * Handler tests for the live ground-ingest route: status codes, machine
 * auth gating, payload validation, and the logged consent rejection —
 * exactly as a gateway caller sees them.
 *
 * Fully hermetic (no describeIfDb): `resolveRequestAuth` and the Prisma
 * client module are vi.mock()ed, so no database, no Better Auth, and no
 * network beyond the throwaway local Express server. Fixtures synthetic.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "node:http";

const { resolveRequestAuthMock, prismaStub } = vi.hoisted(() => {
  const sources: Array<Record<string, unknown>> = [];
  const prismaStub = {
    __sources: sources,
    groundSources: {
      findMany: async ({ where }: { where: { transportId: { in: string[] } } }) =>
        sources.filter((s) => where.transportId.in.includes(s.transportId as string)),
    },
    groundMessages: {
      findMany: async () => [],
    },
    groundThreads: {
      create: vi.fn(async () => ({ id: "t1" })),
    },
  };
  return { resolveRequestAuthMock: vi.fn(), prismaStub };
});

vi.mock("../../src/utils/request-auth.js", () => ({
  resolveRequestAuth: resolveRequestAuthMock,
}));

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaStub }));

const { enqueueGroundClassificationMock } = vi.hoisted(() => ({
  enqueueGroundClassificationMock: vi.fn(),
}));

vi.mock("../../src/services/ground-classify.js", () => ({
  enqueueGroundClassification: enqueueGroundClassificationMock,
}));

import express from "express";
import { groundIngestRouter } from "../../src/routes/ground-ingest.js";

const CONSENTED_JID = "111000111@g.us";

const VALID_MESSAGE = {
  groupJid: CONSENTED_JID,
  messageId: "MSG001",
  senderJid: "333000333@s.whatsapp.net",
  senderName: "Synthetic Sender",
  timestamp: "2026-08-04T10:00:00.000Z",
  text: "Synthetic live-capture test message.",
};

describe("POST /api/ground/ingest", () => {
  let server: Server;
  let url: string;

  async function post(body: unknown) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    const app = express();
    app.use("/api/ground/ingest", groundIngestRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/api/ground/ingest`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resolveRequestAuthMock.mockReset();
    enqueueGroundClassificationMock.mockClear();
    prismaStub.groundThreads.create.mockClear();
    prismaStub.__sources.length = 0;
    prismaStub.__sources.push({
      id: "gs_consented",
      transportId: CONSENTED_JID,
      isActive: true,
      consentScope: "full_message_content",
      consentRecordedAt: new Date("2026-08-01T00:00:00Z"),
      consentRecordedBy: "Test Facilitator (synthetic)",
    });
  });

  it("401s an unauthenticated caller", async () => {
    resolveRequestAuthMock.mockResolvedValue({ user: null, session: null, authMethod: null });
    const res = await post(VALID_MESSAGE);
    expect(res.status).toBe(401);
  });

  it("403s a non-machine role (analyst)", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "u1", role: "analyst" },
      session: null,
      authMethod: "api-key",
    });
    const res = await post(VALID_MESSAGE);
    expect(res.status).toBe(403);
    expect(prismaStub.groundThreads.create).not.toHaveBeenCalled();
  });

  it("accepts a pipeline API-key caller and ingests", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "machine", role: "pipeline" },
      session: null,
      authMethod: "api-key",
    });
    const res = await post(VALID_MESSAGE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, skipped: 0 });
    expect(prismaStub.groundThreads.create).toHaveBeenCalledTimes(1);
    // A batch that created rows enqueues classification for its source.
    expect(enqueueGroundClassificationMock).toHaveBeenCalledExactlyOnceWith("gs_consented");
  });

  it("accepts a batch envelope { messages: [...] }", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "machine", role: "pipeline" },
      session: null,
      authMethod: "api-key",
    });
    const res = await post({
      messages: [VALID_MESSAGE, { ...VALID_MESSAGE, messageId: "MSG002" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 2, skipped: 0 });
  });

  it("400s a malformed payload", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "machine", role: "pipeline" },
      session: null,
      authMethod: "api-key",
    });
    const res = await post({ groupJid: CONSENTED_JID }); // missing everything else
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid payload");
  });

  it("403s AND logs an unconsented group JID, persisting nothing", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "machine", role: "pipeline" },
      session: null,
      authMethod: "api-key",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await post({ ...VALID_MESSAGE, groupJid: "999000999@g.us" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { rejections: Array<{ groupJid: string }> };
    expect(body.rejections[0]?.groupJid).toBe("999000999@g.us");
    expect(prismaStub.groundThreads.create).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("consent gate rejected"),
      expect.stringContaining("999000999@g.us"),
    );
    // Nothing ingested → nothing to classify.
    expect(enqueueGroundClassificationMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
