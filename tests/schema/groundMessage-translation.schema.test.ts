/**
 * Schema contract (#627): the hotline inbox (clear-mvp /inbox) requests a
 * translation with requestGroundMessageTranslation and polls
 * groundThread { messages { translation(locale) } }; the clear-pipeline
 * translate drain fetches groundMessageForTranslation. Resolver-unit tests
 * never validate a selection set against the schema, so this executes the
 * real operations through an ApolloServer instance.
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

const ARABIC = "قصف على السوق الرئيسي";

const message = {
  id: "m1",
  groundSourceId: "gs_1",
  externalId: "hotline:gs_1:m1",
  sentAt: new Date("2026-09-30T10:00:00Z"),
  senderRef: "s_abc123def456",
  senderName: null,
  text: ARABIC,
  language: "ar",
  mediaKeys: [] as string[],
  mediaRefs: [] as string[],
  omittedMediaCount: 0,
  transcript: null,
  classification: null,
  uncertainty: null,
  isEdited: false,
  threadId: "t1",
  createdAt: new Date("2026-09-30T10:00:01Z"),
};

function buildContext(role: string | null, translated: string | null): Context {
  return {
    prisma: {
      groundMessages: {
        findMany: vi.fn(async () => [message]),
        findUnique: vi.fn(async ({ select }: { select?: Record<string, boolean> }) =>
          select ? Object.fromEntries(Object.keys(select).map((k) => [k, message[k as keyof typeof message]])) : message,
        ),
      },
      groundThreads: { findUnique: vi.fn(async () => ({ id: "t1", groundSourceId: "gs_1" })) },
      translationQueue: {
        findUnique: vi.fn(async () => (translated ? null : { id: "q1" })),
        upsert: vi.fn(async () => ({ id: "q1" })),
      },
      translations: {
        findUnique: vi.fn(async () => (translated ? { data: { text: translated } } : null)),
      },
    },
    user: role ? { id: "u1", role } : null,
    session: null,
    authMethod: role ? "session" : null,
    locale: "en",
  } as unknown as Context;
}

async function run(query: string, role: string | null, translated: string | null = null) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query },
    { contextValue: buildContext(role, translated) },
  );
  await server.stop();
  if (response.body.kind !== "single") {
    throw new Error(`Expected a single result, got ${response.body.kind}`);
  }
  return response.body.singleResult;
}

describe("GroundMessage translation schema contract", () => {
  it("requestGroundMessageTranslation queues an English translation", async () => {
    const result = await run(
      `mutation { requestGroundMessageTranslation(messageId: "m1", locale: "en") { locale status text } }`,
      "analyst",
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.requestGroundMessageTranslation).toEqual({
      locale: "en",
      status: "queued",
      text: null,
    });
  });

  it("groundThread.messages exposes language and the ready translation beside the untouched original", async () => {
    const result = await run(
      `query { groundThread(id: "t1") { messages { id text language translation(locale: "en") { status text } } } }`,
      "admin",
      "Shelling at the main market",
    );
    expect(result.errors).toBeUndefined();
    expect((result.data?.groundThread as { messages: unknown }).messages).toEqual([
      {
        id: "m1",
        text: ARABIC,
        language: "ar",
        translation: { status: "ready", text: "Shelling at the main market" },
      },
    ]);
  });

  it("groundMessageForTranslation serves the pipeline text + language", async () => {
    const result = await run(
      `query { groundMessageForTranslation(id: "m1") { id text language } }`,
      "pipeline",
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.groundMessageForTranslation).toEqual({ id: "m1", text: ARABIC, language: "ar" });
  });

  it("a viewer cannot request a translation", async () => {
    const result = await run(
      `mutation { requestGroundMessageTranslation(messageId: "m1", locale: "en") { status } }`,
      "viewer",
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});
