/**
 * Schema contract for the Worker side of the Task protocol (ADR-0010):
 * `claimTasks` and `completeTask` with a `TaskUsageInput` and an
 * `ImpactPriorInput`, the documents clear-mcp's Worker tools send. Executed
 * through a real ApolloServer so the input shapes and the error `subCode`s
 * a Worker branches on (`NOT_LEASED`, `NOT_LEASE_OWNER`) are pinned at the
 * seam.
 *
 * DB-FREE: `context.prisma` is a `vi.fn()` mock.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

const CLAIM_TASKS = `
  mutation ClearClaimTasks($kind: String!, $limit: Int) {
    claimTasks(kind: $kind, limit: $limit) {
      id
      kind
      subjectType
      subjectId
      payload
      status
      leaseOwnerId
      leaseExpiresAt
      attempts
      maxAttempts
    }
  }
`;

const COMPLETE_TASK = `
  mutation ClearCompleteTask($id: String!, $result: JSON!, $usage: TaskUsageInput, $impactPrior: ImpactPriorInput) {
    completeTask(id: $id, result: $result, usage: $usage, impactPrior: $impactPrior) {
      id
      status
      outcome
      result
      model
      inputTokens
      outputTokens
      costUsd
      completedAt
    }
  }
`;

const LEASED = {
  id: "t-1",
  kind: "event.impact_prior",
  subjectType: "event",
  subjectId: "ev-1",
  payload: { horizonYears: 10 },
  status: "LEASED",
  origin: "user",
  requesterId: "u-1",
  teamId: null,
  leaseOwnerId: "u-worker",
  leaseExpiresAt: new Date("2026-10-06T10:15:00Z"),
  attempts: 1,
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

function mockPrisma(task: Record<string, unknown> = LEASED) {
  const prisma: Record<string, unknown> = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "t-1" }]),
    task: {
      findUnique: vi.fn().mockResolvedValue(task),
      findMany: vi.fn().mockResolvedValue([task]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...task, ...data })),
    },
    impactPrior: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ip-1", ...data })),
    },
    events: {
      findUnique: vi.fn().mockResolvedValue({ id: "ev-1", types: ["FL"], locationId: "loc-d", originId: null, destinationId: null }),
    },
    locations: {
      findUnique: vi.fn().mockResolvedValue({ id: "loc-d", level: 2, ancestorIds: ["loc-c"] }),
      findMany: vi.fn().mockResolvedValue([{ id: "loc-c", level: 0 }]),
    },
  };
  prisma.$transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]),
  );
  return prisma;
}

function buildContext(prisma: unknown, user: { id: string; role: string }): Context {
  return {
    prisma, user, session: null, authMethod: "api-key", locale: "en",
  } as unknown as Context;
}

async function run(
  query: string,
  variables: Record<string, unknown>,
  user: { id: string; role: string },
  prisma: unknown = mockPrisma(),
) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: buildContext(prisma, user) },
  );
  await server.stop();
  if (response.body.kind !== "single") {
    throw new Error(`Expected a single result, got ${response.body.kind}`);
  }
  return response.body.singleResult;
}

const WORKER = { id: "u-worker", role: "worker" };

describe("Worker protocol schema contract", () => {
  it("claimTasks executes the Worker's document and returns LEASED rows", async () => {
    const result = await run(CLAIM_TASKS, { kind: "event.impact_prior", limit: 1 }, WORKER);
    expect(result.errors).toBeUndefined();
    expect(result.data?.claimTasks).toEqual([
      expect.objectContaining({ id: "t-1", status: "LEASED", leaseOwnerId: "u-worker", attempts: 1 }),
    ]);
  });

  it("completeTask accepts usage and an ImpactPriorInput and returns the COMPLETED Task", async () => {
    const result = await run(
      COMPLETE_TASK,
      {
        id: "t-1",
        result: { summary: "one case" },
        usage: { model: "anthropic/claude-sonnet-5-5", inputTokens: 1200, outputTokens: 300, costUsd: 0.012 },
        impactPrior: {
          hazardType: "FL",
          countryLocationId: "loc-c",
          geographicScope: "country",
          horizonYears: 10,
          numberOfCases: 1,
          basis: [{ tier: "web", sourceUrl: "https://example.test", quote: "…", scope: "country" }],
          methodVersion: "clear-impact-prior@0.1.0",
        },
      },
      WORKER,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.completeTask).toMatchObject({
      id: "t-1",
      status: "COMPLETED",
      outcome: "produced",
      result: { summary: "one case" },
    });
  });

  it("relays CONFLICT / NOT_LEASED for a Task that is not leased", async () => {
    const result = await run(
      COMPLETE_TASK,
      { id: "t-1", result: {} },
      WORKER,
      mockPrisma({ ...LEASED, status: "PENDING", leaseOwnerId: null }),
    );
    expect(result.errors?.[0]?.extensions).toMatchObject({ code: "CONFLICT", subCode: "NOT_LEASED" });
  });

  it("relays FORBIDDEN / NOT_LEASE_OWNER for another Worker", async () => {
    const result = await run(COMPLETE_TASK, { id: "t-1", result: {} }, { id: "u-worker-2", role: "worker" });
    expect(result.errors?.[0]?.extensions).toMatchObject({ code: "FORBIDDEN", subCode: "NOT_LEASE_OWNER" });
  });

  it("rejects a non-worker on claimTasks with FORBIDDEN", async () => {
    const result = await run(CLAIM_TASKS, { kind: "event.impact_prior" }, { id: "u-p", role: "pipeline" });
    expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});
