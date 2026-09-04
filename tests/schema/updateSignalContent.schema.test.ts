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
 */
import { ApolloServer } from "@apollo/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import { prisma } from "../../src/lib/prisma.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const UPDATE_SIGNAL_CONTENT = `
  mutation UpdateSignalContent($input: UpdateSignalContentInput!) {
    updateSignalContent(input: $input) {
      id
      contentHash
      lastRevisedAt
    }
  }
`;

function buildContext(user: { id: string; role: string } | null): Context {
  return {
    prisma,
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
    locale: "en",
  } as Context;
}

describeIfDb("updateSignalContent schema contract", () => {
  const createdSignalIds: string[] = [];
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  let viewerUserId: string;
  let dataminrSourceId: string;

  beforeAll(async () => {
    await server.start();

    const user = await prisma.user.findFirst({ select: { id: true } });
    if (!user) {
      throw new Error("No user in DB to use as test actor — seed at least one user first.");
    }
    viewerUserId = user.id;

    const dataminr = await prisma.dataSources.findFirst({
      where: { name: "dataminr" },
      select: { id: true },
    });
    if (!dataminr) {
      throw new Error("No 'dataminr' DataSource seeded — required for this test.");
    }
    dataminrSourceId = dataminr.id;
  });

  afterAll(async () => {
    if (createdSignalIds.length > 0) {
      await prisma.$executeRaw`DELETE FROM "signals" WHERE id = ANY(${createdSignalIds}::text[])`;
    }
    await server.stop();
    await prisma.$disconnect();
  });

  it("executes the pipeline's real query without a schema validation error", async () => {
    const created = await prisma.signals.create({
      data: {
        sourceId: dataminrSourceId,
        title: "TEST signal for updateSignalContent schema contract",
        publishedAt: new Date(),
        rawData: { test: true },
        externalId: `test:schema-contract:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    createdSignalIds.push(created.id);

    const response = await server.executeOperation(
      {
        query: UPDATE_SIGNAL_CONTENT,
        variables: {
          input: { id: created.id, contentHash: "test-hash", rawData: { test: true } },
        },
      },
      { contextValue: buildContext({ id: viewerUserId, role: "pipeline" }) },
    );

    if (response.body.kind !== "single") {
      throw new Error(`Expected a single result, got ${response.body.kind}`);
    }
    expect(response.body.singleResult.errors).toBeUndefined();
    expect(response.body.singleResult.data?.updateSignalContent).toMatchObject({
      id: created.id,
      contentHash: "test-hash",
    });
  });
});
