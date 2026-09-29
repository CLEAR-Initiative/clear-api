/**
 * Schema contract (#661): the hotline inbox (clear-mvp /inbox) reads
 * `transcript` and `hasVoice` off `GroundMessage`, both via the top-level
 * `groundMessages` query and via `groundThread { messages }`. Resolver-unit
 * tests never validate a selection set against the schema, so this executes
 * real queries through an ApolloServer instance.
 *
 * DB-FREE: `context.prisma` stubs only the delegates the resolvers touch.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

vi.mock("../../src/services/s3.js", () => ({
  getPresignedUrls: vi.fn(async () => []),
  uploadBufferToS3: vi.fn(),
}));

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "m1",
  groundSourceId: "gs_1",
  externalId: "hotline:gs_1:m1",
  sentAt: new Date("2026-08-04T10:00:00Z"),
  senderRef: "s_abc123def456",
  senderName: null,
  text: "",
  mediaKeys: [] as string[],
  mediaRefs: [] as string[],
  omittedMediaCount: 0,
  transcript: null as string | null,
  classification: null,
  uncertainty: null,
  isEdited: false,
  threadId: "t1",
  createdAt: new Date("2026-08-04T10:00:01Z"),
  ...overrides,
});

const ROWS = [
  // Voice note, transcribed.
  row({
    id: "m1",
    mediaKeys: ["ground/gs_1/a.ogg"],
    mediaRefs: ["voice-0"],
    transcript: "Flooding near the bridge, call [REDACTED]",
  }),
  // Voice note, not yet transcribed (and media not yet stored).
  row({ id: "m2", mediaRefs: ["voice-0"] }),
  // Text-only message.
  row({ id: "m3", text: "road is open" }),
  // Non-voice media.
  row({ id: "m4", mediaKeys: ["ground/gs_1/b.jpg"], mediaRefs: ["media-0"] }),
];

const EXPECTED = [
  { id: "m1", hasVoice: true, transcript: "Flooding near the bridge, call [REDACTED]" },
  { id: "m2", hasVoice: true, transcript: null },
  { id: "m3", hasVoice: false, transcript: null },
  { id: "m4", hasVoice: false, transcript: null },
];

function buildContext(role: string | null): Context {
  const findMany = vi.fn(async () => ROWS);
  return {
    prisma: {
      groundMessages: { findMany },
      groundThreads: { findUnique: vi.fn(async () => ({ id: "t1", groundSourceId: "gs_1" })) },
    },
    user: role ? { id: "u1", role } : null,
    session: null,
    authMethod: role ? "session" : null,
    locale: "en",
  } as unknown as Context;
}

async function run(query: string, role: string | null) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query },
    { contextValue: buildContext(role) },
  );
  await server.stop();
  if (response.body.kind !== "single") {
    throw new Error(`Expected a single result, got ${response.body.kind}`);
  }
  return response.body.singleResult;
}

const GROUND_MESSAGES = `
  query { groundMessages(groundSourceId: "gs_1") { id hasVoice transcript } }
`;

const THREAD_MESSAGES = `
  query { groundThread(id: "t1") { messages { id hasVoice transcript } } }
`;

describe("GroundMessage transcript / hasVoice schema contract", () => {
  it("groundMessages exposes transcript and hasVoice (with and without a transcript)", async () => {
    const result = await run(GROUND_MESSAGES, "analyst");
    expect(result.errors).toBeUndefined();
    expect(result.data?.groundMessages).toEqual(EXPECTED);
  });

  it("groundThread.messages exposes the same fields", async () => {
    const result = await run(THREAD_MESSAGES, "admin");
    expect(result.errors).toBeUndefined();
    expect((result.data?.groundThread as { messages: unknown }).messages).toEqual(EXPECTED);
  });

  it("keeps GroundMessage's role gating: a viewer is FORBIDDEN", async () => {
    const result = await run(GROUND_MESSAGES, "viewer");
    expect(result.data?.groundMessages ?? null).toBeNull();
    expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});
