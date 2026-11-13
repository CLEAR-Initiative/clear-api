/**
 * Unit tests for `analysisDatapoint.resolver.ts` — DB-free (every
 * `context.prisma.*` delegate is a `vi.fn()` stub).
 *
 *   Mutation.upsertAnalysisDatapoints — role gate, empty-id BAD_USER_INPUT,
 *     analysis-not-found NOT_FOUND, create-vs-replace distinction.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";

import { analysisDatapointResolvers } from "../../src/resolvers/analysisDatapoint.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: { ...prisma } as unknown as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
    locale: "en",
  } as Context;
}

const { upsertAnalysisDatapoints } = analysisDatapointResolvers.Mutation;

const VIEWER = { id: "u1", role: "member" };
const PIPELINE = { id: "u2", role: "pipeline" };

const INPUT = {
  analysisId: "an1",
  data: { displaced: { value: 10000 } },
  contributingReportIds: ["r1"],
  schemaVersion: "v1",
};


function prismaWith({ analysis, existing }: { analysis: unknown; existing: unknown }) {
  return {
    analysis: { findUnique: vi.fn().mockResolvedValue(analysis) },
    analysisDatapoint: {
      findUnique: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn().mockResolvedValue({ id: "ad1" }),
    },
  };
}


describe("upsertAnalysisDatapoints", () => {
  it("rejects non-admin/pipeline callers", async () => {
    const ctx = buildContext(VIEWER, prismaWith({ analysis: { id: "an1" }, existing: null }));
    await expect(upsertAnalysisDatapoints({}, { input: INPUT }, ctx)).rejects.toThrow(GraphQLError);
  });

  it("requires analysisId and schemaVersion", async () => {
    const ctx = buildContext(PIPELINE, prismaWith({ analysis: { id: "an1" }, existing: null }));
    await expect(
      upsertAnalysisDatapoints({}, { input: { ...INPUT, analysisId: "" } }, ctx),
    ).rejects.toThrow(/analysisId and schemaVersion are required/);
  });

  it("404s when the analysis does not exist", async () => {
    const ctx = buildContext(PIPELINE, prismaWith({ analysis: null, existing: null }));
    await expect(upsertAnalysisDatapoints({}, { input: INPUT }, ctx)).rejects.toThrow(/not found/);
  });

  it("creates the first row (createdOrReplaced=false)", async () => {
    const prisma = prismaWith({ analysis: { id: "an1" }, existing: null });
    const ctx = buildContext(PIPELINE, prisma);
    const res = await upsertAnalysisDatapoints({}, { input: INPUT }, ctx);
    expect(res).toEqual({ analysisId: "an1", schemaVersion: "v1", createdOrReplaced: false });
    expect(prisma.analysisDatapoint.upsert).toHaveBeenCalledOnce();
  });

  it("reports a replace when a row already exists (createdOrReplaced=true)", async () => {
    const prisma = prismaWith({ analysis: { id: "an1" }, existing: { id: "ad1" } });
    const ctx = buildContext(PIPELINE, prisma);
    const res = await upsertAnalysisDatapoints({}, { input: INPUT }, ctx);
    expect(res.createdOrReplaced).toBe(true);
  });
});
