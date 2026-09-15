/**
 * Handler tests for the Twilio hotline webhook: config guard, signature
 * gating, payload validation, the source gate's logged 200-drop, the
 * empty-TwiML no-outbound guarantee, and the enqueue wiring — exactly as
 * Twilio sees them.
 *
 * Fully hermetic: env, the Prisma client, S3, and both celery enqueues
 * are vi.mock()ed; media bytes come from a stubbed global fetch. Requests
 * are real form-encoded POSTs against a throwaway local Express server,
 * signed with the same scheme Twilio uses.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "node:http";

const HOTLINE_NUMBER = "+14155238886";
const WEBHOOK_URL = "https://clear.example.org/api/webhooks/twilio/whatsapp";
const AUTH_TOKEN = "test-auth-token";

const { envStub, prismaStub, uploadBufferToS3Mock } = vi.hoisted(() => {
  const envStub: Record<string, string | undefined> = {};
  type ThreadCreateArgs = {
    data: { title: string; messages: { create: Record<string, unknown> } };
  };
  const createThread = async ({ data }: ThreadCreateArgs) => {
    prismaStub.__threads.push({ title: data.title, message: { ...data.messages.create } });
    return { id: "t1", messages: [{ id: "gm_1" }] };
  };
  const prismaStub = {
    __source: null as Record<string, unknown> | null,
    __threads: [] as Array<{ title: string; message: Record<string, unknown> }>,
    __createThread: createThread,
    groundSources: {
      findFirst: async ({ where }: { where: { transportId: string } }) =>
        prismaStub.__source && prismaStub.__source.transportId === where.transportId
          ? prismaStub.__source
          : null,
    },
    groundMessages: {
      findFirst: async ({ where }: { where: { externalId: string } }) => {
        const hit = prismaStub.__threads.find((t) => t.message.externalId === where.externalId);
        return hit ? { id: "gm_1", threadId: "t1", mediaKeys: hit.message.mediaKeys } : null;
      },
      update: async ({ data }: { data: { mediaKeys: string[] } }) => {
        const hit = prismaStub.__threads[0];
        if (hit) hit.message.mediaKeys = data.mediaKeys;
        return hit?.message;
      },
    },
    groundThreads: { create: createThread },
  };
  return { envStub, prismaStub, uploadBufferToS3Mock: vi.fn() };
});

vi.mock("../../src/utils/env.js", () => ({ env: envStub }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaStub }));
vi.mock("../../src/services/s3.js", () => ({ uploadBufferToS3: uploadBufferToS3Mock }));

const { enqueueClassificationMock, enqueueTranscriptionMock } = vi.hoisted(() => ({
  enqueueClassificationMock: vi.fn(),
  enqueueTranscriptionMock: vi.fn(),
}));

vi.mock("../../src/services/ground-classify.js", () => ({
  enqueueGroundClassification: enqueueClassificationMock,
}));

vi.mock("../../src/services/hotline-ingest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/hotline-ingest.js")>();
  return { ...actual, enqueueGroundTranscription: enqueueTranscriptionMock };
});

import express from "express";
import {
  hotlineWebhookRouter,
  MAX_HOTLINE_MEDIA_BYTES,
} from "../../src/routes/hotline-webhook.js";
import { computeTwilioSignature } from "../../src/services/twilio-signature.js";
import { hotlinePseudonym } from "../../src/services/hotline-ingest.js";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

const ACTIVE_HOTLINE = {
  id: "gs_hotline",
  kind: "hotline",
  transportId: HOTLINE_NUMBER,
  isActive: true,
};

function baseParams(extra: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: "SM001",
    From: "whatsapp:+249111222333",
    To: `whatsapp:${HOTLINE_NUMBER}`,
    Body: "Attack on the village this morning",
    NumMedia: "0",
    ...extra,
  };
}

describe("POST /api/webhooks/twilio/whatsapp", () => {
  let server: Server;
  let url: string;

  async function post(
    params: Record<string, string>,
    options: { sign?: boolean; signature?: string } = {},
  ) {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    const signature =
      options.signature ??
      (options.sign === false
        ? undefined
        : computeTwilioSignature(AUTH_TOKEN, WEBHOOK_URL, params));
    if (signature) headers["x-twilio-signature"] = signature;
    return fetch(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(params).toString(),
    });
  }

  beforeAll(async () => {
    const app = express();
    app.use("/api/webhooks/twilio/whatsapp", hotlineWebhookRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/api/webhooks/twilio/whatsapp`;
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    envStub.TWILIO_ACCOUNT_SID = "ACxxx";
    envStub.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    envStub.HOTLINE_WEBHOOK_URL = WEBHOOK_URL;
    envStub.HOTLINE_PSEUDONYM_SECRET = "test-secret-at-least-16-chars";
    prismaStub.__source = { ...ACTIVE_HOTLINE };
    prismaStub.__threads.length = 0;
    enqueueClassificationMock.mockReset();
    enqueueTranscriptionMock.mockReset();
    uploadBufferToS3Mock.mockReset();
    uploadBufferToS3Mock.mockImplementation(async (_buf: Buffer, key: string) => key);
    prismaStub.groundThreads.create = prismaStub.__createThread;
    vi.unstubAllGlobals();
  });

  /** Stub the global fetch for Twilio media URLs only — the stub also
   * intercepts the test's own request to the local server, so those are
   * routed to the real implementation. */
  function stubMediaFetch(
    handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("http://127.0.0.1")) return realFetch(input, init);
      return handler(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const VOICE_PARAMS = {
    Body: "",
    NumMedia: "1",
    MediaUrl0: "https://api.twilio.com/2010-04-01/Accounts/AC/Messages/SM001/Media/ME1",
    MediaContentType0: "audio/ogg",
  };

  it("503s (loudly) when the hotline env is not configured", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    envStub.HOTLINE_PSEUDONYM_SECRET = undefined;

    const res = await post(baseParams());
    expect(res.status).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not configured"));
    errorSpy.mockRestore();
  });

  it("403s a missing signature", async () => {
    const res = await post(baseParams(), { sign: false });
    expect(res.status).toBe(403);
    expect(prismaStub.__threads).toHaveLength(0);
  });

  it("403s (not 500s) an unsigned non-form POST, e.g. JSON from a scanner", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ MessageSid: "SM001" }),
    });
    expect(res.status).toBe(403);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(prismaStub.__threads).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it("403s an unsigned empty-body POST", async () => {
    const res = await fetch(url, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("403s a signature over a tampered body", async () => {
    const params = baseParams();
    const signature = computeTwilioSignature(AUTH_TOKEN, WEBHOOK_URL, params);
    const res = await post({ ...params, Body: "tampered" }, { signature });
    expect(res.status).toBe(403);
  });

  it("400s a payload missing MessageSid", async () => {
    const params = baseParams();
    delete params.MessageSid;
    const res = await post(params);
    expect(res.status).toBe(400);
  });

  it("drops a message to an unregistered number with a 200, empty TwiML, and a logged reason", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    prismaStub.__source = null;

    const res = await post(baseParams());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EMPTY_TWIML);
    expect(prismaStub.__threads).toHaveLength(0);
    expect(enqueueClassificationMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("gate rejected message SM001"),
    );
    warnSpy.mockRestore();
  });

  it("ingests a text submission: empty TwiML back, anonymized row, classification enqueued", async () => {
    const res = await post(baseParams());

    expect(res.status).toBe(200);
    // NO OUTBOUND: the response must be the empty <Response/> — a
    // <Message> element here would text the reporter back.
    expect(await res.text()).toBe(EMPTY_TWIML);
    expect(res.headers.get("content-type")).toContain("text/xml");

    expect(prismaStub.__threads).toHaveLength(1);
    const message = prismaStub.__threads[0].message;
    expect(message.senderName).toBeNull();
    expect(message.senderRef).toBe(
      hotlinePseudonym("test-secret-at-least-16-chars", HOTLINE_NUMBER, "whatsapp:+249111222333"),
    );
    expect(JSON.stringify(message)).not.toContain("+249111222333");

    expect(enqueueClassificationMock).toHaveBeenCalledExactlyOnceWith("gs_hotline");
    expect(enqueueTranscriptionMock).not.toHaveBeenCalled();
  });

  it("is idempotent on a Twilio retry of the same MessageSid", async () => {
    expect((await post(baseParams())).status).toBe(200);
    expect((await post(baseParams())).status).toBe(200);

    expect(prismaStub.__threads).toHaveLength(1);
    expect(enqueueClassificationMock).toHaveBeenCalledTimes(1);
  });

  it("fetches voice media with Twilio auth, stores it, and enqueues transcription", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const fetchMock = stubMediaFetch(async () => new Response(bytes, { status: 200 }));

    const params = baseParams(VOICE_PARAMS);
    const res = await post(params);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EMPTY_TWIML);

    // Twilio media fetch carried basic auth.
    const mediaCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("api.twilio.com"),
    );
    expect(mediaCall).toBeDefined();
    expect((mediaCall?.[1]?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    // Bounded: the fetch carries an abort signal (per-attachment timeout).
    expect(mediaCall?.[1]?.signal).toBeInstanceOf(AbortSignal);

    // Stored under the ground content-hash scheme with the audio extension.
    expect(uploadBufferToS3Mock).toHaveBeenCalledTimes(1);
    const [, key, contentType] = uploadBufferToS3Mock.mock.calls[0];
    expect(key).toMatch(/^ground\/gs_hotline\/[0-9a-f]{64}\.ogg$/);
    expect(contentType).toBe("audio/ogg");

    expect(prismaStub.__threads[0].message.mediaKeys).toEqual([key]);
    expect(enqueueTranscriptionMock).toHaveBeenCalledExactlyOnceWith("gm_1");
  });

  it("500s when a media fetch aborts, but the message row is already persisted", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubMediaFetch(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    const res = await post(baseParams(VOICE_PARAMS));
    expect(res.status).toBe(500);
    // Persist-before-media: the report survives even if Twilio never retries.
    expect(prismaStub.__threads).toHaveLength(1);
    expect(prismaStub.__threads[0].message.mediaKeys).toEqual([]);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
    // Nothing enqueued for a half-ingested message; the retry does that.
    expect(enqueueClassificationMock).not.toHaveBeenCalled();
    expect(enqueueTranscriptionMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("backfills media and enqueues on the retry after a media failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempt = 0;
    stubMediaFetch(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      return new Response(new Uint8Array([9, 9, 9]).buffer, { status: 200 });
    });

    expect((await post(baseParams(VOICE_PARAMS))).status).toBe(500);
    const retry = await post(baseParams(VOICE_PARAMS));
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(EMPTY_TWIML);

    expect(prismaStub.__threads).toHaveLength(1);
    expect(prismaStub.__threads[0].message.mediaKeys).toHaveLength(1);
    expect(enqueueClassificationMock).toHaveBeenCalledExactlyOnceWith("gs_hotline");
    expect(enqueueTranscriptionMock).toHaveBeenCalledExactlyOnceWith("gm_1");
    errorSpy.mockRestore();
  });

  it("rejects media whose declared size exceeds the cap without buffering it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubMediaFetch(
      async () =>
        new Response(new Uint8Array([1]).buffer, {
          status: 200,
          headers: { "content-length": String(MAX_HOTLINE_MEDIA_BYTES + 1) },
        }),
    );

    const res = await post(baseParams(VOICE_PARAMS));
    expect(res.status).toBe(500);
    expect(uploadBufferToS3Mock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[hotline-webhook] Failed:",
      expect.objectContaining({ message: expect.stringContaining("too large") }),
    );
    errorSpy.mockRestore();
  });

  it("500s when persistence fails (Twilio retries only with the 5xx override configured)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaStub.groundThreads.create = async () => {
      throw new Error("db down");
    };
    const res = await post(baseParams());
    expect(res.status).toBe(500);
    expect(prismaStub.__threads).toHaveLength(0);
    errorSpy.mockRestore();
  });
});
