/**
 * Schema contract for the Worker side of the Task protocol (ADR-0010):
 * `claimTasks` and `completeTask` with a `TaskUsageInput` and web `cases`
 * (`CaseProposalInput`), the documents clear-mcp's Worker tools send.
 * Executed through a real ApolloServer so the input shapes and the error
 * `subCode`s a Worker branches on (`NOT_LEASED`, `NOT_LEASE_OWNER`) are
 * pinned at the seam. Also pins that the retired whole-prior surface
 * (`impactPrior: ImpactPriorInput`, `decideImpactPrior`, `Query.impactPriors`)
 * is gone: an old Worker or client fails validation, never half-writes.
 *
 * DB-FREE: `context.prisma` is a `vi.fn()` mock.
 */
import { ApolloServer } from "@apollo/server";
import { makeExecutableSchema } from "@graphql-tools/schema";
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
      leaseToken
      leaseExpiresAt
      attempts
      maxAttempts
    }
  }
`;

const HEARTBEAT_TASK = `
  mutation ClearHeartbeatTask($id: String!, $leaseToken: String!) {
    heartbeatTask(id: $id, leaseToken: $leaseToken) {
      id
      status
      leaseOwnerId
      leaseExpiresAt
      cancelRequestedAt
    }
  }
`;

const FAIL_TASK = `
  mutation ClearFailTask($id: String!, $leaseToken: String!, $error: String!) {
    failTask(id: $id, leaseToken: $leaseToken, error: $error) {
      id
      status
      attempts
      maxAttempts
      lastError
    }
  }
`;

const COMPLETE_TASK = `
  mutation ClearCompleteTask(
    $id: String!
    $leaseToken: String!
    $result: JSON!
    $usage: TaskUsageInput
    $cases: [CaseProposalInput!]
    $methodVersion: String
  ) {
    completeTask(
      id: $id
      leaseToken: $leaseToken
      result: $result
      usage: $usage
      cases: $cases
      methodVersion: $methodVersion
    ) {
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

/** A pre-retirement Worker's completion: the whole-prior argument. */
const COMPLETE_TASK_WITH_IMPACT_PRIOR = `
  mutation ClearCompleteTask($id: String!, $leaseToken: String!, $result: JSON!, $impactPrior: ImpactPriorInput) {
    completeTask(id: $id, leaseToken: $leaseToken, result: $result, impactPrior: $impactPrior) {
      id
      status
    }
  }
`;

/** The same, with the prior inline — no variable type to trip over first. */
const COMPLETE_TASK_WITH_INLINE_IMPACT_PRIOR = `
  mutation ClearCompleteTask($id: String!, $leaseToken: String!) {
    completeTask(
      id: $id
      leaseToken: $leaseToken
      result: {}
      impactPrior: {
        hazardType: "FL"
        countryLocationId: "loc-c"
        geographicScope: "country"
        horizonYears: 10
        numberOfCases: 1
        basis: []
        methodVersion: "clear-impact-prior@0.1.0"
      }
    ) {
      id
      status
    }
  }
`;

/** clear-mvp's retired whole-prior decision. */
const DECIDE_IMPACT_PRIOR = `
  mutation DecideImpactPrior($id: String!, $decision: ImpactPriorDecision!, $rationale: String!) {
    decideImpactPrior(id: $id, decision: $decision, rationale: $rationale) {
      id
      state
    }
  }
`;

/** clear-mvp's retired whole-prior Inbox list. */
const IMPACT_PRIORS_INBOX = `
  query ImpactPriorsInbox($state: ImpactPriorState) {
    impactPriors(state: $state) {
      id
      state
    }
  }
`;

const WEB_CASE = {
  sourceUrl: "https://example.test/floods-2021",
  quote: "Floods displaced 4,000 people.",
  occurredAt: "2021-08-01T00:00:00Z",
  locationLabel: "Country C",
  hazardType: "FL",
  geographicScope: "country",
};

const LEASED = {
  id: "t-1",
  kind: "event.impact_prior.web",
  subjectType: "event",
  subjectId: "ev-1",
  payload: { horizonYears: 10 },
  status: "LEASED",
  origin: "user",
  requesterId: "u-1",
  teamId: null,
  leaseOwnerId: "u-worker",
  leaseToken: "tok-1",
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
  let current: Record<string, unknown> = { ...task };
  const prisma: Record<string, unknown> = {
    $queryRaw: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ id: "t-1" }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    user: { findMany: vi.fn().mockResolvedValue([]) },
    notifications: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    task: {
      findUnique: vi.fn(async () => current),
      findUniqueOrThrow: vi.fn(async () => current),
      findMany: vi.fn().mockResolvedValue([task]),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const ok = Object.entries(where).every(([k, v]) => current[k] === v);
        if (ok) current = { ...current, ...data };
        return { count: ok ? 1 : 0 };
      }),
    },
    caseProposal: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
    events: {
      findUnique: vi.fn().mockResolvedValue({ id: "ev-1", types: ["FL"], locationId: "loc-d", originId: null, destinationId: null }),
    },
    locations: {
      findUnique: vi.fn().mockResolvedValue({ id: "loc-d", level: 2, ancestorIds: ["loc-c"] }),
      findFirst: vi.fn().mockResolvedValue({ id: "loc-c" }),
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

/** The prisma mock's task-write spies, to prove nothing was written. */
function taskWrites(prisma: Record<string, unknown>) {
  const task = prisma.task as { updateMany: ReturnType<typeof vi.fn> };
  const cases = prisma.caseProposal as { createMany: ReturnType<typeof vi.fn> };
  return { taskUpdate: task.updateMany, caseCreate: cases.createMany };
}

describe("Worker protocol schema contract", () => {
  it("claimTasks executes the Worker's document and returns LEASED rows", async () => {
    const result = await run(CLAIM_TASKS, { kind: "event.impact_prior.web", limit: 1 }, WORKER);
    expect(result.errors).toBeUndefined();
    expect(result.data?.claimTasks).toEqual([
      expect.objectContaining({ id: "t-1", status: "LEASED", leaseOwnerId: "u-worker", leaseToken: "tok-1", attempts: 1 }),
    ]);
  });

  it.each(["event.impact_prior", "event.impact_prior.clear"])(
    "claimTasks refuses the retired kind %s with BAD_USER_INPUT, claiming nothing",
    async (kind) => {
      const prisma = mockPrisma();
      const result = await run(CLAIM_TASKS, { kind, limit: 1 }, WORKER, prisma);
      expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
      expect(result.errors?.[0]?.message).toMatch(/retired kind/);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it("heartbeatTask executes the Worker's document and returns the extended lease", async () => {
    const result = await run(HEARTBEAT_TASK, { id: "t-1", leaseToken: "tok-1" }, WORKER);
    expect(result.errors).toBeUndefined();
    const row = result.data?.heartbeatTask as { status: string; leaseExpiresAt: string };
    expect(row.status).toBe("LEASED");
    expect(new Date(row.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it("failTask executes the Worker's document and returns the Task to PENDING with its error", async () => {
    const result = await run(FAIL_TASK, { id: "t-1", leaseToken: "tok-1", error: "rate limited" }, WORKER);
    expect(result.errors).toBeUndefined();
    expect(result.data?.failTask).toMatchObject({ id: "t-1", status: "PENDING", lastError: "rate limited", attempts: 1 });
  });

  it("completeTask accepts usage and web cases and returns the COMPLETED Task", async () => {
    const prisma = mockPrisma();
    const result = await run(
      COMPLETE_TASK,
      {
        id: "t-1",
        leaseToken: "tok-1",
        result: { summary: "one case" },
        usage: { model: "anthropic/claude-sonnet-5-5", inputTokens: 1200, outputTokens: 300, costUsd: 0.012 },
        cases: [WEB_CASE],
        methodVersion: "clear-impact-prior@0.2.0",
      },
      WORKER,
      prisma,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.completeTask).toMatchObject({
      id: "t-1",
      status: "COMPLETED",
      outcome: "produced",
      result: { summary: "one case" },
      model: "anthropic/claude-sonnet-5-5",
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.012,
    });
    expect(taskWrites(prisma).caseCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ sourceUrl: WEB_CASE.sourceUrl, methodVersion: "clear-impact-prior@0.2.0" })],
      }),
    );
  });

  it("completeTask without cases records no_prior_found", async () => {
    const prisma = mockPrisma();
    const result = await run(COMPLETE_TASK, { id: "t-1", leaseToken: "tok-1", result: { cases: 0 } }, WORKER, prisma);
    expect(result.errors).toBeUndefined();
    expect(result.data?.completeTask).toMatchObject({ status: "COMPLETED", outcome: "no_prior_found" });
    expect(taskWrites(prisma).caseCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["declaring $impactPrior: ImpactPriorInput", COMPLETE_TASK_WITH_IMPACT_PRIOR],
    ["passing impactPrior inline", COMPLETE_TASK_WITH_INLINE_IMPACT_PRIOR],
  ])("completeTask fails validation for a whole-prior Worker %s, before any write", async (_name, query) => {
    const prisma = mockPrisma();
    const result = await run(query, { id: "t-1", leaseToken: "tok-1", result: {} }, WORKER, prisma);
    expect(result.data).toBeUndefined();
    expect(result.errors?.[0]?.extensions?.code).toBe("GRAPHQL_VALIDATION_FAILED");
    expect(result.errors?.map((e) => e.message).join("\n")).toMatch(/impactPrior|ImpactPriorInput/);
    const { taskUpdate, caseCreate } = taskWrites(prisma);
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(caseCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["decideImpactPrior", DECIDE_IMPACT_PRIOR, { id: "ip-1", decision: "accepted", rationale: "ok" }],
    ["Query.impactPriors", IMPACT_PRIORS_INBOX, { state: "proposed" }],
  ])("%s no longer exists: clear-mvp's document fails validation", async (_name, query, variables) => {
    const result = await run(query, variables, { id: "u-a", role: "admin" });
    expect(result.data).toBeUndefined();
    expect(result.errors?.[0]?.extensions?.code).toBe("GRAPHQL_VALIDATION_FAILED");
  });

  it("relays CONFLICT / NOT_LEASED for a Task that is not leased", async () => {
    const result = await run(
      COMPLETE_TASK,
      { id: "t-1", leaseToken: "tok-1", result: {} },
      WORKER,
      mockPrisma({ ...LEASED, status: "PENDING", leaseOwnerId: null }),
    );
    expect(result.errors?.[0]?.extensions).toMatchObject({ code: "CONFLICT", subCode: "NOT_LEASED" });
  });

  it("relays FORBIDDEN / NOT_LEASE_OWNER for another Worker", async () => {
    const result = await run(COMPLETE_TASK, { id: "t-1", leaseToken: "tok-1", result: {} }, { id: "u-worker-2", role: "worker" });
    expect(result.errors?.[0]?.extensions).toMatchObject({ code: "FORBIDDEN", subCode: "NOT_LEASE_OWNER" });
  });

  it("rejects a non-worker on claimTasks with FORBIDDEN", async () => {
    const result = await run(CLAIM_TASKS, { kind: "event.impact_prior.web" }, { id: "u-p", role: "pipeline" });
    expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});

describe("the retired whole-prior surface is gone from the schema", () => {
  const schema = makeExecutableSchema({ typeDefs, resolvers });

  it("has no decideImpactPrior mutation and no impactPriors Inbox query", () => {
    expect(schema.getMutationType()!.getFields()).not.toHaveProperty("decideImpactPrior");
    expect(schema.getQueryType()!.getFields()).not.toHaveProperty("impactPriors");
  });

  it("has no ImpactPriorInput or ImpactPriorDecision, and completeTask takes no impactPrior", () => {
    expect(schema.getType("ImpactPriorInput")).toBeUndefined();
    expect(schema.getType("ImpactPriorDecision")).toBeUndefined();
    const args = schema.getMutationType()!.getFields().completeTask.args.map((a) => a.name);
    expect(args).not.toContain("impactPrior");
    expect(args).toEqual(expect.arrayContaining(["cases", "methodVersion"]));
  });

  it("keeps the history read: type ImpactPrior, eventImpactPriors and Event.impactPriors", () => {
    expect(schema.getType("ImpactPrior")).toBeDefined();
    expect(schema.getType("ImpactPriorState")).toBeDefined();
    expect(schema.getQueryType()!.getFields()).toHaveProperty("eventImpactPriors");
    const event = schema.getType("Event") as { getFields(): Record<string, unknown> };
    expect(event.getFields()).toHaveProperty("impactPriors");
  });
});
