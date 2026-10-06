/**
 * Schema contract for `requestEventEnrichment` (ADR-0010): the mutation
 * clear-mvp's `tasks.requestEnrichment` procedure sends, executed through a
 * real ApolloServer so the argument shape, the selection set and the error
 * `subCode`s a client branches on are pinned at the seam — resolver-level
 * tests never validate a document against the schema.
 *
 * DB-FREE: `context.prisma` is a `vi.fn()` mock.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

const REQUEST_EVENT_ENRICHMENT = `
  mutation RequestEventEnrichment($eventId: String!, $teamId: String, $horizonYears: Int) {
    requestEventEnrichment(eventId: $eventId, teamId: $teamId, horizonYears: $horizonYears) {
      id
      kind
      subjectType
      subjectId
      status
      origin
      requesterId
      teamId
      payload
      attempts
      maxAttempts
      lastError
      createdAt
    }
  }
`;

function mockPrisma() {
  const created = {
    id: "t-1",
    kind: "event.impact_prior",
    subjectType: "event",
    subjectId: "ev-1",
    payload: { horizonYears: 10 },
    status: "PENDING",
    origin: "user",
    requesterId: "u-1",
    teamId: null,
    leaseOwnerId: null,
    leaseExpiresAt: null,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    cancelRequestedAt: null,
    cancelledById: null,
    outcome: null,
    result: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    completedAt: null,
    createdAt: new Date("2026-10-06T10:00:00Z"),
    updatedAt: new Date("2026-10-06T10:00:00Z"),
  };
  return {
    events: { findUnique: vi.fn().mockResolvedValue({ id: "ev-1" }) },
    task: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(created),
    },
    activityLogs: { create: vi.fn().mockResolvedValue({}) },
  };
}

function buildContext(prisma: unknown, user: { id: string; role: string } | null): Context {
  return {
    prisma, user, session: null, authMethod: user ? "session" : null, locale: "en",
  } as unknown as Context;
}

async function run(user: { id: string; role: string } | null, variables: Record<string, unknown>) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query: REQUEST_EVENT_ENRICHMENT, variables },
    { contextValue: buildContext(mockPrisma(), user) },
  );
  await server.stop();
  if (response.body.kind !== "single") {
    throw new Error(`Expected a single result, got ${response.body.kind}`);
  }
  return response.body.singleResult;
}

describe("requestEventEnrichment schema contract", () => {
  it("executes clear-mvp's document and returns the PENDING Task", async () => {
    const result = await run({ id: "u-1", role: "analyst" }, { eventId: "ev-1" });
    expect(result.errors).toBeUndefined();
    expect(result.data?.requestEventEnrichment).toMatchObject({
      id: "t-1",
      kind: "event.impact_prior",
      status: "PENDING",
      origin: "user",
      payload: { horizonYears: 10 },
    });
  });

  it("surfaces FORBIDDEN with the guard's code for a viewer without a team", async () => {
    const result = await run({ id: "u-1", role: "viewer" }, { eventId: "ev-1" });
    expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });

  it("surfaces UNAUTHENTICATED when there is no user", async () => {
    const result = await run(null, { eventId: "ev-1" });
    expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
  });
});
