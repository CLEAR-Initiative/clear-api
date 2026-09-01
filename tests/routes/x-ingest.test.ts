/**
 * Handler tests for the X push-feed ingest route: status codes, machine
 * auth gating, payload validation, and the created/skipped dedup
 * arithmetic — exactly as the external poller sees them.
 *
 * Fully hermetic (no describeIfDb): `resolveRequestAuth` and the Prisma
 * client module are vi.mock()ed, so no database, no Better Auth, and no
 * network beyond the throwaway local Express server. Fixtures synthetic.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "node:http";

const { resolveRequestAuthMock, prismaStub } = vi.hoisted(() => {
  const sources: Array<Record<string, unknown>> = [];
  // Simulates the [sourceId, externalId] unique constraint that
  // createMany(skipDuplicates) rides in production.
  const seenExternalIds = new Set<string>();
  const prismaStub = {
    __sources: sources,
    __seenExternalIds: seenExternalIds,
    dataSources: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { name: string; isActive: boolean };
          take?: number;
        }) =>
          sources
            .filter((s) => s.name === where.name && s.isActive === where.isActive)
            .slice(0, take),
      ),
    },
    signals: {
      createMany: vi.fn(
        async ({
          data,
        }: {
          data: Array<{ sourceId: string; externalId: string }>;
          skipDuplicates: boolean;
        }) => {
          let count = 0;
          for (const row of data) {
            const key = `${row.sourceId}:${row.externalId}`;
            if (seenExternalIds.has(key)) continue;
            seenExternalIds.add(key);
            count += 1;
          }
          return { count };
        },
      ),
    },
  };
  return { resolveRequestAuthMock: vi.fn(), prismaStub };
});

vi.mock("../../src/utils/request-auth.js", () => ({
  resolveRequestAuth: resolveRequestAuthMock,
}));

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaStub }));

import express from "express";
import { xIngestRouter, truncateTitle } from "../../src/routes/x-ingest.js";

const SAMPLE_EVENT = {
  id: "2094734567902953601",
  url: "https://x.com/ADFmagazine/status/2094734567902953601",
  created_at: "2026-09-01T10:30:13Z",
  author: {
    username: "ADFmagazine",
    name: "ADF Magazine",
    verified: true,
  },
  text: "Synthetic Sudan-war test post.",
  metrics: {
    likes: 1,
    reposts: 0,
    replies: 0,
  },
};

const SAMPLE_BATCH = {
  source: "sudan-war-x",
  generated_at: "2026-09-01T14:19:00Z",
  since_id: "2094734567902953601",
  events: [SAMPLE_EVENT],
};

function asPipeline() {
  resolveRequestAuthMock.mockResolvedValue({
    user: { id: "machine", role: "pipeline" },
    session: null,
    authMethod: "api-key",
  });
}

describe("POST /api/x/ingest", () => {
  let server: Server;
  let url: string;

  async function post(body: unknown) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    const app = express();
    app.use("/api/x/ingest", xIngestRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/api/x/ingest`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resolveRequestAuthMock.mockReset();
    prismaStub.dataSources.findMany.mockClear();
    prismaStub.signals.createMany.mockClear();
    prismaStub.__seenExternalIds.clear();
    prismaStub.__sources.length = 0;
    prismaStub.__sources.push({
      id: "ds_sudan_war_x",
      name: "sudan-war-x",
      type: "webhook",
      isActive: true,
    });
  });

  it("ingests the sample payload: 200 { created: 1, skipped: 0 }", async () => {
    asPipeline();
    const res = await post(SAMPLE_BATCH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, skipped: 0 });

    expect(prismaStub.signals.createMany).toHaveBeenCalledTimes(1);
    const args = prismaStub.signals.createMany.mock.calls[0]?.[0] as {
      data: Array<Record<string, unknown>>;
      skipDuplicates: boolean;
    };
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(1);
    const row = args.data[0]!;
    expect(row.sourceId).toBe("ds_sudan_war_x");
    expect(row.externalId).toBe("x:2094734567902953601");
    expect(row.description).toBe(SAMPLE_EVENT.text);
    // The drain owns processing status — the route must never set it.
    expect(row).not.toHaveProperty("status");
  });

  it("skips a redelivered batch: 200 { created: 0, skipped: 1 }", async () => {
    asPipeline();
    const first = await post(SAMPLE_BATCH);
    expect(await first.json()).toEqual({ created: 1, skipped: 0 });

    const second = await post(SAMPLE_BATCH);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ created: 0, skipped: 1 });
  });

  it("401s an unauthenticated caller, persisting nothing", async () => {
    resolveRequestAuthMock.mockResolvedValue({ user: null, session: null, authMethod: null });
    const res = await post(SAMPLE_BATCH);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("403s a non-machine role (analyst), persisting nothing", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "u1", role: "analyst" },
      session: null,
      authMethod: "api-key",
    });
    const res = await post(SAMPLE_BATCH);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("accepts an admin caller (manual testing path)", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "u2", role: "admin" },
      session: null,
      authMethod: "api-key",
    });
    const res = await post(SAMPLE_BATCH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, skipped: 0 });
  });

  it("400s malformed JSON with a JSON error body, persisting nothing", async () => {
    asPipeline();
    const res = await post('{"source": "sudan-war-x", not json');
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("400s a schema violation (event missing id), persisting nothing", async () => {
    asPipeline();
    const { id: _dropped, ...eventWithoutId } = SAMPLE_EVENT;
    const res = await post({ ...SAMPLE_BATCH, events: [eventWithoutId] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe("Invalid payload");
    expect(body.details.some((d) => d.includes("events.0.id"))).toBe(true);
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("400s an unknown source, persisting nothing", async () => {
    asPipeline();
    const res = await post({ ...SAMPLE_BATCH, source: "no-such-feed" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown source" });
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("400s an inactive source, persisting nothing", async () => {
    asPipeline();
    prismaStub.__sources.length = 0;
    prismaStub.__sources.push({
      id: "ds_sudan_war_x",
      name: "sudan-war-x",
      type: "webhook",
      isActive: false,
    });
    const res = await post(SAMPLE_BATCH);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown source" });
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("500s an ambiguous source name (two active rows), persisting nothing", async () => {
    asPipeline();
    prismaStub.__sources.push({
      id: "ds_sudan_war_x_dupe",
      name: "sudan-war-x",
      type: "webhook",
      isActive: true,
    });
    const res = await post(SAMPLE_BATCH);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Ingest failed" });
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("400s a timezone-less created_at rather than reading it as server-local", async () => {
    asPipeline();
    const res = await post({
      ...SAMPLE_BATCH,
      events: [{ ...SAMPLE_EVENT, created_at: "2026-09-01T10:30:13" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid payload");
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("413s an oversized (>1 MB) but valid JSON body with a distinct message", async () => {
    asPipeline();
    const res = await post({
      ...SAMPLE_BATCH,
      events: [{ ...SAMPLE_EVENT, text: "x".repeat(1_100_000) }],
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Payload too large" });
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("400s a batch over 100 events, persisting nothing", async () => {
    asPipeline();
    const events = Array.from({ length: 101 }, (_, i) => ({
      ...SAMPLE_EVENT,
      id: `event-${i}`,
    }));
    const res = await post({ ...SAMPLE_BATCH, events });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid payload");
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("accepts exactly 100 events (cap is inclusive)", async () => {
    asPipeline();
    const events = Array.from({ length: 100 }, (_, i) => ({
      ...SAMPLE_EVENT,
      id: `event-${i}`,
    }));
    const res = await post({ ...SAMPLE_BATCH, events });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 100, skipped: 0 });
  });

  it("200s an empty events array with zero counts, touching no tables", async () => {
    asPipeline();
    const res = await post({ ...SAMPLE_BATCH, events: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 0, skipped: 0 });
    expect(prismaStub.dataSources.findMany).not.toHaveBeenCalled();
    expect(prismaStub.signals.createMany).not.toHaveBeenCalled();
  });

  it("maps every Signal column from the event", async () => {
    asPipeline();
    const longText =
      "Reports of renewed shelling near the airport this morning, with residents describing sustained artillery exchanges between rival forces across several districts of the city since dawn prayers.";
    const extraEvent = {
      ...SAMPLE_EVENT,
      text: longText,
      lang: "en",
      author: { ...SAMPLE_EVENT.author, followers: 12345 },
    };
    const res = await post({ ...SAMPLE_BATCH, events: [extraEvent] });
    expect(res.status).toBe(200);

    const args = prismaStub.signals.createMany.mock.calls[0]?.[0] as {
      data: Array<Record<string, unknown>>;
    };
    const row = args.data[0]!;
    expect(row.sourceId).toBe("ds_sudan_war_x");
    expect(row.externalId).toBe("x:2094734567902953601");
    // rawData is the event verbatim — unknown extras included, at both the
    // event and author level.
    expect(row.rawData).toEqual(extraEvent);
    expect(row.publishedAt).toEqual(new Date("2026-09-01T10:30:13Z"));
    expect(row.url).toBe(SAMPLE_EVENT.url);
    expect(row.description).toBe(longText);
    // Title is a word-boundary truncation of the text, capped at 100 chars.
    const title = row.title as string;
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title.endsWith("…")).toBe(true);
    expect(longText.startsWith(title.slice(0, -1))).toBe(true);
    // Nothing beyond the mapped columns — the drain owns status et al.
    expect(Object.keys(row).sort()).toEqual([
      "description",
      "externalId",
      "publishedAt",
      "rawData",
      "sourceId",
      "title",
      "url",
    ]);
  });

  it("ignores unknown extra fields at every level rather than rejecting", async () => {
    asPipeline();
    const res = await post({
      ...SAMPLE_BATCH,
      poller_version: "max-1.2",
      events: [
        {
          ...SAMPLE_EVENT,
          lang: "en",
          author: { ...SAMPLE_EVENT.author, followers: 12345 },
          metrics: { ...SAMPLE_EVENT.metrics, views: 999 },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, skipped: 0 });
  });
});

describe("truncateTitle", () => {
  it("returns short text untouched — no ellipsis", () => {
    expect(truncateTitle("Shelling reported in Omdurman.")).toBe(
      "Shelling reported in Omdurman.",
    );
  });

  it("returns text of exactly 100 chars untouched", () => {
    const exact = "a".repeat(100);
    expect(truncateTitle(exact)).toBe(exact);
  });

  it("cuts long text on a word boundary, ellipsis included, within 100 chars", () => {
    const words = "conflict update ".repeat(10).trim(); // 159 chars
    const title = truncateTitle(words);
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title.endsWith("…")).toBe(true);
    const withoutEllipsis = title.slice(0, -1);
    // The cut lands after a whole word: what precedes the ellipsis is a
    // prefix of the text that ends exactly at a word boundary.
    expect(words.startsWith(withoutEllipsis)).toBe(true);
    expect([" ", undefined]).toContain(words[withoutEllipsis.length]);
    expect(withoutEllipsis.endsWith(" ")).toBe(false);
  });

  it("hard-cuts an unbroken 150-char token to 99 + ellipsis", () => {
    const unbroken = "x".repeat(150);
    const title = truncateTitle(unbroken);
    expect(title).toBe(`${"x".repeat(99)}…`);
  });
});
