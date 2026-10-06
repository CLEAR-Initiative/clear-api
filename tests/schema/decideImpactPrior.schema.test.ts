/**
 * Schema contract for `decideImpactPrior` (V2): the document clear-mvp's
 * `tasks.decideImpactPrior` procedure sends, through a real ApolloServer, so
 * the enum, the arguments and the error codes a client branches on are
 * pinned at the seam.
 *
 * DB-FREE: `context.prisma` is a `vi.fn()` mock.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

const DECIDE = `
  mutation DecideImpactPrior($id: String!, $decision: ImpactPriorDecision!, $rationale: String!) {
    decideImpactPrior(id: $id, decision: $decision, rationale: $rationale) {
      id
      state
      decidedById
      decidedAt
      decisionRationale
    }
  }
`;

function mockPrisma(state = "proposed") {
  let row: Record<string, unknown> = {
    id: "ip-1", eventId: "ev-1", taskId: "t-1", state, decidedById: null, decidedAt: null, decisionRationale: null,
  };
  return {
    impactPrior: {
      findUnique: vi.fn(async () => row),
      findUniqueOrThrow: vi.fn(async () => row),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const ok = Object.entries(where).every(([k, v]) => row[k] === v);
        if (ok) row = { ...row, ...data };
        return { count: ok ? 1 : 0 };
      }),
    },
    activityLogs: { create: vi.fn(async () => ({})) },
  };
}

async function run(user: { id: string; role: string }, variables: Record<string, unknown>, prisma = mockPrisma()) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query: DECIDE, variables },
    { contextValue: { prisma, user, session: null, authMethod: "session", locale: "en" } as unknown as Context },
  );
  await server.stop();
  if (response.body.kind !== "single") throw new Error(`Expected a single result, got ${response.body.kind}`);
  return response.body.singleResult;
}

describe("decideImpactPrior schema contract", () => {
  it("executes clear-mvp's document and returns the decided ImpactPrior", async () => {
    const result = await run({ id: "u-1", role: "analyst" }, { id: "ip-1", decision: "accepted", rationale: "Solid cases." });
    expect(result.errors).toBeUndefined();
    expect(result.data?.decideImpactPrior).toMatchObject({ id: "ip-1", state: "accepted", decidedById: "u-1", decisionRationale: "Solid cases." });
  });

  it("rejects an unknown decision at the schema", async () => {
    const result = await run({ id: "u-1", role: "analyst" }, { id: "ip-1", decision: "maybe", rationale: "x" });
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("surfaces FORBIDDEN for a viewer and CONFLICT for an already-decided row", async () => {
    const forbidden = await run({ id: "u-1", role: "viewer" }, { id: "ip-1", decision: "accepted", rationale: "x" });
    expect(forbidden.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    const conflict = await run({ id: "u-1", role: "admin" }, { id: "ip-1", decision: "accepted", rationale: "x" }, mockPrisma("rejected"));
    expect(conflict.errors?.[0]?.extensions?.code).toBe("CONFLICT");
  });
});
