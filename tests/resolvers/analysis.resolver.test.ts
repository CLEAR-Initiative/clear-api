/**
 * Tests for the unified frame-scoped analysis resolver (ADR-0007).
 *
 * DB-FREE: `context.prisma` is a `vi.fn()` mock per delegate; `$transaction`
 * runs a callback against the mock (upsert) or resolves an array of updates
 * (markRan). Covers the surface the mirrored `situationAnalysis.resolver.test.ts`
 * has for its resolver: auth gates, frame canonicalization, bitemporal
 * supersede ordering, the on-demand dedupe, the P2002 races, and cadence
 * anchoring (the things the review's A5–A9 turned on).
 */
import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { Prisma } from "../../src/generated/prisma/client.js";

import { analysisResolvers } from "../../src/resolvers/analysis.resolver.js";
import type { Context } from "../../src/context.js";

function makePrisma(overrides: Record<string, unknown> = {}) {
  const analysis = {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "an-1", ...data })),
  };
  const analysisAutomation = {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "au-1", ...data })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "au-1", ...data })),
    delete: vi.fn(async () => ({ id: "au-1" })),
  };
  const analysisRequest = {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "rq-1", ...data })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "rq-1", ...data })),
  };
  const prisma: Record<string, unknown> = { analysis, analysisAutomation, analysisRequest };
  // upsert passes a callback (tx === the same mock); markRan passes an array.
  prisma.$transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
  Object.assign(prisma, overrides);
  return prisma;
}

function ctx(user: { id: string; role: string } | null, prisma = makePrisma()): Context {
  return {
    prisma, user, session: null, authMethod: user ? "session" : null, locale: "en",
  } as unknown as Context;
}

const admin = { id: "u-admin", role: "admin" };
const pipeline = { id: "u-pipe", role: "pipeline" };
const analyst = { id: "u-analyst", role: "analyst" };
const viewer = { id: "u-viewer", role: "viewer" };

const p2002 = new Prisma.PrismaClientKnownRequestError("dup", {
  code: "P2002", clientVersion: "x",
});

describe("analysis resolver", () => {
  describe("upsertAnalysis — pipeline write", () => {
    const input = () => ({
      locationIds: ["b", "a", "b"], eventTypes: ["FL"], needSectors: [],
      windowStart: new Date("2026-01-01"), windowEnd: new Date("2026-12-31"),
      data: { ai_summary: {} }, sourceReportIds: ["r1"],
      generatedByModel: "claude-sonnet-4-6", schemaVersion: "v4",
    });

    it("rejects a viewer with FORBIDDEN", async () => {
      await expect(
        analysisResolvers.Mutation.upsertAnalysis(null, { input: input() }, ctx(viewer)),
      ).rejects.toThrow(/insufficient permissions/i);
    });

    it("rejects an analyst (write is admin/pipeline only)", async () => {
      await expect(
        analysisResolvers.Mutation.upsertAnalysis(null, { input: input() }, ctx(analyst)),
      ).rejects.toThrow(/insufficient permissions/i);
    });

    it("rejects a missing schemaVersion", async () => {
      const bad = { ...input(), schemaVersion: "" };
      await expect(
        analysisResolvers.Mutation.upsertAnalysis(null, { input: bad }, ctx(pipeline)),
      ).rejects.toThrow(GraphQLError);
    });

    it("canonicalizes the frame arrays and supersedes BEFORE inserting", async () => {
      const prisma = makePrisma();
      const order: string[] = [];
      (prisma.analysis as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockImplementation(async () => {
        order.push("updateMany");
        return { count: 1 };
      });
      (prisma.analysis as { create: ReturnType<typeof vi.fn> }).create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        order.push("create");
        return { id: "an-9", ...data };
      });

      const res = await analysisResolvers.Mutation.upsertAnalysis(
        null, { input: input() }, ctx(pipeline, prisma),
      );

      expect(order).toEqual(["updateMany", "create"]); // validTo stamped first
      expect(res).toEqual({ analysisId: "an-9", supersededPrevious: true });
      // Frame arrays canonicalised (sorted + de-duped) on the create.
      const createArg = (prisma.analysis as { create: ReturnType<typeof vi.fn> }).create.mock.calls[0][0].data;
      expect(createArg.locationIds).toEqual(["a", "b"]);
      // Supersede keyed on the SAME canonical arrays + validTo:null.
      const whereArg = (prisma.analysis as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mock.calls[0][0].where;
      expect(whereArg.locationIds).toEqual({ equals: ["a", "b"] });
      expect(whereArg.validTo).toBeNull();
    });

    it("reports supersededPrevious=false when nothing was current", async () => {
      const prisma = makePrisma();
      (prisma.analysis as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockResolvedValue({ count: 0 });
      const res = await analysisResolvers.Mutation.upsertAnalysis(
        null, { input: input() }, ctx(pipeline, prisma),
      );
      expect(res.supersededPrevious).toBe(false);
    });
  });

  describe("analysis query — frame read", () => {
    it("requires a content reader", async () => {
      await expect(
        analysisResolvers.Query.analysis(
          null, { frame: { locationIds: ["a"], windowStart: new Date("2026-01-01") } }, ctx(null),
        ),
      ).rejects.toThrow(GraphQLError);
    });

    it("canonicalizes the frame and applies the bitemporal filter", async () => {
      const prisma = makePrisma();
      await analysisResolvers.Query.analysis(
        null,
        { frame: { locationIds: ["y", "x"], eventTypes: [], needSectors: [], windowStart: new Date("2026-01-01") } },
        ctx(viewer, prisma),
      );
      const where = (prisma.analysis as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mock.calls[0][0].where;
      expect(where.locationIds).toEqual({ equals: ["x", "y"] });
      expect(where.windowEnd).toBeNull(); // rolling frame lookup
      expect(where.OR).toEqual([{ validTo: null }, { validTo: { gt: expect.any(Date) } }]);
    });
  });

  describe("requestAnalysis — on-demand enqueue + dedupe", () => {
    const input = () => ({ locationIds: ["a"], windowStart: new Date("2026-01-01"), windowEnd: new Date("2026-06-30") });

    it("is admin/analyst only", async () => {
      await expect(
        analysisResolvers.Mutation.requestAnalysis(null, { input: input() }, ctx(viewer)),
      ).rejects.toThrow(/insufficient permissions/i);
    });

    it("returns the existing PENDING request instead of creating a duplicate", async () => {
      const prisma = makePrisma();
      (prisma.analysisRequest as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockResolvedValue({ id: "rq-existing", status: "PENDING" });
      const res = await analysisResolvers.Mutation.requestAnalysis(null, { input: input() }, ctx(analyst, prisma));
      expect(res).toEqual({ id: "rq-existing", status: "PENDING" });
      expect((prisma.analysisRequest as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
    });

    it("on a create P2002 race, returns the winner", async () => {
      const prisma = makePrisma();
      const rq = prisma.analysisRequest as { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
      rq.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "rq-winner", status: "PENDING" });
      rq.create.mockRejectedValue(p2002);
      const res = await analysisResolvers.Mutation.requestAnalysis(null, { input: input() }, ctx(analyst, prisma));
      expect(res).toEqual({ id: "rq-winner", status: "PENDING" });
    });
  });

  describe("createAnalysisAutomation — re-subscribe updates cadence", () => {
    const input = () => ({ locationIds: ["a"], windowStart: new Date("2026-01-01"), cadence: "daily" });

    it("updates the existing (frame, owner) automation on a P2002 rather than throwing", async () => {
      const prisma = makePrisma();
      const au = prisma.analysisAutomation as {
        create: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>;
      };
      au.create.mockRejectedValue(p2002);
      au.findFirst.mockResolvedValue({ id: "au-existing" });
      const res = await analysisResolvers.Mutation.createAnalysisAutomation(null, { input: input() }, ctx(analyst, prisma));
      expect(au.update).toHaveBeenCalledWith({ where: { id: "au-existing" }, data: { cadence: "daily", enabled: true } });
      expect(res.cadence).toBe("daily");
    });
  });

  describe("markAnalysisAutomationsRan — cadence anchoring (A5)", () => {
    it("advances nextRunAt from the PRIOR schedule, not wall-clock", async () => {
      const prior = new Date("2026-03-01T00:00:00Z"); // already due
      const prisma = makePrisma();
      const au = prisma.analysisAutomation as { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
      au.findMany.mockResolvedValue([{ id: "au-1", cadence: "weekly", nextRunAt: prior }]);

      const before = Date.now();
      await analysisResolvers.Mutation.markAnalysisAutomationsRan(null, { ids: ["au-1"] }, ctx(pipeline, prisma));
      const next = (au.update.mock.calls[0][0].data.nextRunAt as Date).getTime();

      // Anchored to prior + N*week (a multiple of 7d past the prior time), and in
      // the future — NOT simply now + 7d.
      const WEEK = 604_800_000;
      expect((next - prior.getTime()) % WEEK).toBe(0);
      expect(next).toBeGreaterThan(before);
    });

    it("is admin/pipeline only", async () => {
      await expect(
        analysisResolvers.Mutation.markAnalysisAutomationsRan(null, { ids: ["x"] }, ctx(analyst)),
      ).rejects.toThrow(/insufficient permissions/i);
    });
  });

  describe("dueAnalysisAutomations — scheduler drain", () => {
    it("selects enabled rows that are never-run or past-due, pipeline-gated", async () => {
      const prisma = makePrisma();
      await analysisResolvers.Query.dueAnalysisAutomations(null, {}, ctx(pipeline, prisma));
      const where = (prisma.analysisAutomation as { findMany: ReturnType<typeof vi.fn> }).findMany.mock.calls[0][0].where;
      expect(where.enabled).toBe(true);
      expect(where.OR).toEqual([{ nextRunAt: null }, { nextRunAt: { lte: expect.any(Date) } }]);
    });

    it("rejects a non-pipeline/admin caller", async () => {
      await expect(
        analysisResolvers.Query.dueAnalysisAutomations(null, {}, ctx(viewer)),
      ).rejects.toThrow(/insufficient permissions/i);
    });
  });

  describe("pendingAnalyses — on-demand drain", () => {
    it("returns PENDING oldest-first, pipeline-gated", async () => {
      const prisma = makePrisma();
      await analysisResolvers.Query.pendingAnalyses(null, {}, ctx(pipeline, prisma));
      const call = (prisma.analysisRequest as { findMany: ReturnType<typeof vi.fn> }).findMany.mock.calls[0][0];
      expect(call.where).toEqual({ status: "PENDING" });
      expect(call.orderBy).toEqual({ createdAt: "asc" });
    });
  });

  describe("markAnalysisRequestFailed — bumps attempts", () => {
    it("sets FAILED and increments the attempt counter", async () => {
      const prisma = makePrisma();
      await analysisResolvers.Mutation.markAnalysisRequestFailed(null, { id: "rq-1", error: "boom" }, ctx(pipeline, prisma));
      const data = (prisma.analysisRequest as { update: ReturnType<typeof vi.fn> }).update.mock.calls[0][0].data;
      expect(data.status).toBe("FAILED");
      expect(data.attempts).toEqual({ increment: 1 });
      expect(data.lastError).toBe("boom");
    });
  });
});
