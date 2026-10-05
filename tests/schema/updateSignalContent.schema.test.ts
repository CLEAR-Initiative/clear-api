/**
 * Schema contract: resolver-level tests (tests/resolvers/updateSignalContent.
 * resolver.test.ts) call signalResolvers.Mutation.updateSignalContent
 * directly — that never validates a query's selection set against the
 * schema, so a field the resolver writes but the Signal type doesn't expose
 * (or vice versa) passes those tests and only fails in production. This
 * executes the pipeline's ACTUAL query (clear-context-pipeline's
 * providers/clear_api.py UPDATE_SIGNAL_CONTENT, mirrored below — keep in
 * sync if that query changes) through a real ApolloServer instance, the
 * same way the pipeline's HTTP request does.
 *
 * DB-FREE: `context.prisma` is a `vi.fn()` mock (the resolver only calls
 * `signals.findUnique` + `signals.updateMany`), so the schema/selection-set
 * validation runs without a seeded database.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

const UPDATE_SIGNAL_CONTENT = `
  mutation UpdateSignalContent($input: UpdateSignalContentInput!) {
    updateSignalContent(input: $input) {
      id
      contentHash
      lastRevisedAt
      retracted
      revision
      rawS3Key
      status
    }
  }
`;

/** Stateful-enough mock: findUnique returns the stored row (with _count when
 *  asked), updateMany applies `data` to it. The stored signal has a DIFFERENT
 *  contentHash so the resolver takes the write branch. */
function mockPrisma() {
  const stored: Record<string, unknown> = {
    id: "sig-1", sourceId: "src-1", externalId: "ext-1", contentHash: "old-hash",
    lastRevisedAt: null, retracted: false, revision: 0, rawS3Key: null, status: "NEW",
  };
  return {
    signals: {
      findUnique: vi.fn(async (args: { include?: unknown }) => ({
        ...stored, ...(args.include ? { _count: { signalEvents: 0 } } : {}),
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) {
            stored[k] = (stored[k] as number) + (v as { increment: number }).increment;
          } else if (v !== undefined) stored[k] = v;
        }
        return { count: 1 };
      }),
    },
  };
}

function buildContext(prisma: unknown, user: { id: string; role: string }): Context {
  return {
    prisma, user, session: null, authMethod: "session", locale: "en",
  } as unknown as Context;
}

async function run(input: Record<string, unknown>, prisma = mockPrisma()) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query: UPDATE_SIGNAL_CONTENT, variables: { input } },
    { contextValue: buildContext(prisma, { id: "u", role: "pipeline" }) },
  );
  await server.stop();
  if (response.body.kind !== "single") {
    throw new Error(`Expected a single result, got ${response.body.kind}`);
  }
  return { result: response.body.singleResult, prisma };
}

describe("updateSignalContent schema contract", () => {
  it("executes the pipeline's real query (by id) without a schema validation error", async () => {
    const { result } = await run({ id: "sig-1", contentHash: "test-hash", rawData: { test: true } });
    expect(result.errors).toBeUndefined();
    expect(result.data?.updateSignalContent).toMatchObject({
      id: "sig-1", contentHash: "test-hash", retracted: false, revision: 1,
    });
  });

  it("API-S-01 validates with natural key, retracted and rawS3Key (and no id)", async () => {
    const { result, prisma } = await run({
      sourceId: "src-1", externalId: "ext-1", contentHash: "test-hash",
      retracted: true, rawS3Key: "bronze/x.json", rawData: { test: true },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.updateSignalContent).toMatchObject({
      id: "sig-1", retracted: true, rawS3Key: "bronze/x.json", revision: 1,
    });
    expect(prisma.signals.findUnique.mock.calls[0][0]).toMatchObject({
      where: { sourceId_externalId: { sourceId: "src-1", externalId: "ext-1" } },
    });
  });

  it("API-S-02 validates without id (id is optional in the SDL)", async () => {
    const { result } = await run({ sourceId: "src-1", externalId: "ext-1", contentHash: "h", rawData: {} });
    expect(result.errors).toBeUndefined();
  });

  it("API-S-03 validates with retracted: null (treated as absent)", async () => {
    const { result } = await run({ id: "sig-1", contentHash: "h", retracted: null, rawData: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data?.updateSignalContent).toMatchObject({ retracted: false });
  });

  it("surfaces BAD_USER_INPUT through GraphQL when no key is supplied", async () => {
    const { result } = await run({ contentHash: "h", rawData: {} });
    expect(result.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("still requires contentHash and rawData", async () => {
    const { result } = await run({ id: "sig-1" });
    expect(result.errors?.[0].message).toMatch(/contentHash|rawData/);
  });
});
