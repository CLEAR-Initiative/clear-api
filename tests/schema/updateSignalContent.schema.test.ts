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
 * `signals.findUnique` + `signals.update`), so the schema/selection-set
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
    }
  }
`;

/** Mock prisma with just the two delegates the resolver touches. The stored
 *  signal has a DIFFERENT contentHash so the resolver takes the update branch. */
function mockPrisma() {
  const existing = { id: "sig-1", contentHash: "old-hash", lastRevisedAt: null };
  return {
    signals: {
      findUnique: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockResolvedValue({
        ...existing, contentHash: "test-hash", lastRevisedAt: new Date(),
      }),
    },
  };
}

function buildContext(prisma: unknown, user: { id: string; role: string }): Context {
  return {
    prisma, user, session: null, authMethod: "session", locale: "en",
  } as unknown as Context;
}

describe("updateSignalContent schema contract", () => {
  it("executes the pipeline's real query without a schema validation error", async () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    await server.start();

    const response = await server.executeOperation(
      {
        query: UPDATE_SIGNAL_CONTENT,
        variables: {
          input: { id: "sig-1", contentHash: "test-hash", rawData: { test: true } },
        },
      },
      { contextValue: buildContext(mockPrisma(), { id: "u", role: "pipeline" }) },
    );

    await server.stop();

    if (response.body.kind !== "single") {
      throw new Error(`Expected a single result, got ${response.body.kind}`);
    }
    expect(response.body.singleResult.errors).toBeUndefined();
    expect(response.body.singleResult.data?.updateSignalContent).toMatchObject({
      id: "sig-1",
      contentHash: "test-hash",
    });
  });
});
