/**
 * Schema contract for `myTasks` (ADR-0010, V2): the query clear-mvp's
 * "My requests" Inbox view sends, executed through a real ApolloServer so
 * the argument shape (optional `status`, paged) and the selection set are
 * pinned at the seam, and the worker role's refusal surfaces as FORBIDDEN.
 *
 * DB-FREE: `context.prisma` is a `vi.fn()` mock.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

const MY_TASKS = `
  query MyTasks($status: TaskStatus, $limit: Int, $offset: Int) {
    myTasks(status: $status, limit: $limit, offset: $offset) {
      id
      kind
      subjectType
      subjectId
      status
      origin
      requesterId
      teamId
      attempts
      maxAttempts
      lastError
      outcome
      completedAt
      createdAt
    }
  }
`;

const TASK = {
  id: "t-1",
  kind: "event.impact_prior",
  subjectType: "event",
  subjectId: "ev-1",
  payload: { horizonYears: 10 },
  status: "FAILED",
  origin: "user",
  requesterId: "u-1",
  teamId: null,
  leaseOwnerId: null,
  leaseExpiresAt: null,
  leaseToken: null,
  attempts: 3,
  maxAttempts: 3,
  lastError: "attempt 3 failed",
  cancelRequestedAt: null,
  cancelledById: null,
  outcome: null,
  result: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  completedAt: null,
  createdAt: new Date("2026-10-07T10:00:00Z"),
  updatedAt: new Date("2026-10-07T10:00:00Z"),
};

function mockPrisma() {
  return { task: { findMany: vi.fn().mockResolvedValue([TASK]) } };
}

async function run(user: { id: string; role: string } | null, variables: Record<string, unknown>) {
  const prisma = mockPrisma();
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query: MY_TASKS, variables },
    { contextValue: { prisma, user, session: null, authMethod: user ? "session" : null, locale: "en" } as unknown as Context },
  );
  await server.stop();
  if (response.body.kind !== "single") throw new Error(`Expected a single result, got ${response.body.kind}`);
  return { result: response.body.singleResult, prisma };
}

describe("myTasks schema contract", () => {
  it("executes the document for the requester, scoped to them, with lastError present", async () => {
    const { result, prisma } = await run({ id: "u-1", role: "viewer" }, {});
    expect(result.errors).toBeUndefined();
    expect(result.data?.myTasks).toEqual([
      expect.objectContaining({ id: "t-1", status: "FAILED", lastError: "attempt 3 failed", requesterId: "u-1" }),
    ]);
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { requesterId: "u-1" }, take: 50, skip: 0 }),
    );
  });

  it("passes an optional status filter and the page through", async () => {
    const { result, prisma } = await run({ id: "u-1", role: "analyst" }, { status: "PENDING", limit: 10, offset: 20 });
    expect(result.errors).toBeUndefined();
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { requesterId: "u-1", status: "PENDING" }, take: 10, skip: 20 }),
    );
  });

  it("rejects a status outside the enum at the schema", async () => {
    const { result } = await run({ id: "u-1", role: "analyst" }, { status: "DONE" });
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("surfaces FORBIDDEN for the worker role and UNAUTHENTICATED without a user", async () => {
    expect((await run({ id: "u-w", role: "worker" }, {})).result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect((await run(null, {})).result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
  });
});
