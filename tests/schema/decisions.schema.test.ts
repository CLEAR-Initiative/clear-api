/**
 * Schema contract for `decisions` (ADR-0024, #1287): the feed the gx pipeline
 * polls, executed through a real ApolloServer so the argument and selection
 * shape, the BigInt sequence serialised as Int, and the DecisionType enum are
 * pinned at the seam.
 *
 * DB-FREE: `context.prisma` is a `vi.fn()` mock.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

const DECISIONS = `
  query Decisions($sinceSequence: Int!, $types: [DecisionType!], $first: Int) {
    decisions(sinceSequence: $sinceSequence, types: $types, first: $first) {
      lastSequence
      items {
        id
        sequence
        decisionType
        subjectType
        subjectId
        decidedById
        decidedAt
        viaAgent
        rationale
        payload
        supersedesId
        definitionVersion
      }
    }
  }
`;

const ROW = {
  id: "dr-1",
  sequence: 42n,
  decisionType: "SIGNAL_SEVERITY_SET",
  subjectType: "signal",
  subjectId: "s-1",
  decidedById: "u-1",
  decidedAt: new Date("2026-11-26T10:00:00Z"),
  viaAgent: false,
  rationale: null,
  evidenceCited: null,
  payload: { previousSeverity: 2, severity: 5 },
  supersedesId: null,
  correlationId: null,
  clientRequestId: null,
  definitionVersion: "decision-records-v1",
};

async function run(user: { id: string; role: string }, sinceSequence: number, extra: Record<string, unknown> = {}) {
  const prisma = { decisionRecords: { findMany: vi.fn().mockResolvedValue([ROW]) } };
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query: DECISIONS, variables: { sinceSequence, ...extra } },
    { contextValue: { prisma, user, session: null, authMethod: "api-key", locale: "en" } as unknown as Context },
  );
  await server.stop();
  if (response.body.kind !== "single") throw new Error(`Expected a single result, got ${response.body.kind}`);
  return { result: response.body.singleResult, prisma };
}

describe("decisions schema contract", () => {
  it("returns the page with the sequence as an Int and the last sequence as the cursor", async () => {
    const { result, prisma } = await run({ id: "p-1", role: "pipeline" }, 41);
    expect(result.errors).toBeUndefined();
    expect(result.data?.decisions).toEqual({
      lastSequence: 42,
      items: [
        expect.objectContaining({
          id: "dr-1",
          sequence: 42,
          decisionType: "SIGNAL_SEVERITY_SET",
          payload: { previousSeverity: 2, severity: 5 },
        }),
      ],
    });
    expect(prisma.decisionRecords.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sequence: { gt: 41n } }, orderBy: { sequence: "asc" }, take: 500 }),
    );
  });

  it("filters by type and cuts a page size over the hard maximum to 1000", async () => {
    const { result, prisma } = await run({ id: "p-1", role: "pipeline" }, 0, {
      types: ["SIGNAL_SEVERITY_SET"],
      first: 5000,
    });
    expect(result.errors).toBeUndefined();
    expect(prisma.decisionRecords.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sequence: { gt: 0n }, decisionType: { in: ["SIGNAL_SEVERITY_SET"] } },
        take: 1000,
      }),
    );
  });

  it("is FORBIDDEN for a member", async () => {
    const { result } = await run({ id: "m-1", role: "member" }, 0);
    expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});
