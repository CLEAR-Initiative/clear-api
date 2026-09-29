/**
 * Schema contract (#659): durable failure markers for the clear-pipeline
 * ground drains. clear-pipeline calls `markGroundMessagesFailed` with the
 * `GroundPipelineStage` enum; the hotline inbox reads the markers off
 * `GroundMessage` and clears them with `retryGroundMessage`. Resolver-unit
 * tests never validate operations against the schema, so this executes real
 * operations through an ApolloServer instance.
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

const FAILED_AT = new Date("2026-09-20T08:00:00Z");

const ROW = {
  id: "m1",
  groundSourceId: "gs_1",
  externalId: "hotline:gs_1:m1",
  sentAt: new Date("2026-08-04T10:00:00Z"),
  senderRef: "s_abc123def456",
  senderName: null,
  text: "",
  mediaKeys: ["ground/gs_1/a.amr"],
  mediaRefs: ["voice-0"],
  omittedMediaCount: 0,
  transcript: null,
  classification: null,
  uncertainty: null,
  isEdited: false,
  threadId: "t1",
  createdAt: new Date("2026-08-04T10:00:01Z"),
  enrichFailedAt: null,
  enrichError: null,
  transcribeFailedAt: FAILED_AT,
  transcribeError: "unsupported format: amr",
};

function buildContext(role: string | null): Context {
  return {
    prisma: {
      groundMessages: {
        findMany: vi.fn(async () => [ROW]),
        findUnique: vi.fn(async () => ({ id: ROW.id })),
        update: vi.fn(async () => ({ ...ROW, transcribeFailedAt: null, transcribeError: null })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
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

const FAILURE_FIELDS = "id enrichFailedAt enrichError transcribeFailedAt transcribeError";

const EXPECTED_FAILURE = {
  id: "m1",
  enrichFailedAt: null,
  enrichError: null,
  transcribeFailedAt: FAILED_AT.toISOString(),
  transcribeError: "unsupported format: amr",
};

describe("ground failure-marker schema contract", () => {
  it("GroundMessage exposes the failure markers to reviewers", async () => {
    const result = await run(
      `query { groundMessages(groundSourceId: "gs_1") { ${FAILURE_FIELDS} } }`,
      "analyst",
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.groundMessages).toEqual([EXPECTED_FAILURE]);
  });

  it("GroundMessageForClassification exposes them to the pipeline", async () => {
    const result = await run(
      `query { groundMessagesForClassification(groundSourceId: "gs_1") { ${FAILURE_FIELDS} } }`,
      "pipeline",
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.groundMessagesForClassification).toEqual([EXPECTED_FAILURE]);
  });

  it("markGroundMessagesFailed accepts the stage enum", async () => {
    const result = await run(
      `mutation {
        markGroundMessagesFailed(inputs: [
          { messageId: "m1", stage: TRANSCRIBE, error: "unsupported format: amr" }
        ])
      }`,
      "pipeline",
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.markGroundMessagesFailed).toBe(1);
  });

  it("rejects a stage outside the enum at validation", async () => {
    const result = await run(
      `mutation {
        markGroundMessagesFailed(inputs: [{ messageId: "m1", stage: CLASSIFY, error: "x" }])
      }`,
      "pipeline",
    );
    expect(result.errors?.[0]?.message).toMatch(/GroundPipelineStage/);
  });

  it("retryGroundMessage returns the cleared GroundMessage", async () => {
    const result = await run(
      `mutation { retryGroundMessage(messageId: "m1", stage: TRANSCRIBE) { ${FAILURE_FIELDS} } }`,
      "analyst",
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.retryGroundMessage).toEqual({
      ...EXPECTED_FAILURE,
      transcribeFailedAt: null,
      transcribeError: null,
    });
  });
});
