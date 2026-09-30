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
    findUnique: vi.fn(async (): Promise<{ teamId: string | null } | null> => null),
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
  // Membership fixture: analyst belongs to team-a only.
  const MEMBERSHIPS: Record<string, string[]> = { "u-analyst": ["team-a"], "u-viewer": ["team-a"] };
  const teamMembers = {
    findUnique: vi.fn(async ({ where }: { where: { teamId_userId: { teamId: string; userId: string } } }) => {
      const { teamId, userId } = where.teamId_userId;
      return (MEMBERSHIPS[userId] ?? []).includes(teamId) ? { teamId, userId, role: "team_member" } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
      (MEMBERSHIPS[where.userId] ?? []).map((teamId) => ({ teamId })),
    ),
  };
  const prisma: Record<string, unknown> = { analysis, analysisAutomation, analysisRequest, teamMembers };
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
    const input = () => ({ locationIds: ["a"], windowStart: new Date("2026-01-01"), cadence: "daily", teamId: "team-a" });

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

  describe("team authorization (S1/S2)", () => {
    type Fn = ReturnType<typeof vi.fn>;
    const au = (prisma: Record<string, unknown>) => prisma.analysisAutomation as Record<string, Fn>;
    const createInput = (teamId: string | null) => ({
      locationIds: ["a"], windowStart: new Date("2026-01-01"), cadence: "daily", teamId,
    });

    describe("analysisAutomations — list scoping", () => {
      it("admin with no teamId sees everything (no team filter)", async () => {
        const prisma = makePrisma();
        await analysisResolvers.Query.analysisAutomations(null, {}, ctx(admin, prisma));
        expect(au(prisma).findMany.mock.calls[0][0].where).toEqual({});
      });

      it("admin can list any team without membership", async () => {
        const prisma = makePrisma();
        await analysisResolvers.Query.analysisAutomations(null, { teamId: "team-b" }, ctx(admin, prisma));
        expect(au(prisma).findMany.mock.calls[0][0].where).toEqual({ teamId: "team-b" });
      });

      it("member can list their team", async () => {
        const prisma = makePrisma();
        await analysisResolvers.Query.analysisAutomations(null, { teamId: "team-a", enabledOnly: true }, ctx(viewer, prisma));
        expect(au(prisma).findMany.mock.calls[0][0].where).toEqual({ teamId: "team-a", enabled: true });
      });

      it("non-member is FORBIDDEN for another team", async () => {
        const prisma = makePrisma();
        await expect(
          analysisResolvers.Query.analysisAutomations(null, { teamId: "team-b" }, ctx(viewer, prisma)),
        ).rejects.toThrow(/not a member/i);
        expect(au(prisma).findMany).not.toHaveBeenCalled();
      });

      it("non-admin with no teamId is scoped to their own teams", async () => {
        const prisma = makePrisma();
        await analysisResolvers.Query.analysisAutomations(null, {}, ctx(analyst, prisma));
        expect(au(prisma).findMany.mock.calls[0][0].where).toEqual({ teamId: { in: ["team-a"] } });
      });

      it("non-admin with no memberships gets an empty scope", async () => {
        const prisma = makePrisma();
        await analysisResolvers.Query.analysisAutomations(null, {}, ctx({ id: "u-lonely", role: "viewer" }, prisma));
        expect(au(prisma).findMany.mock.calls[0][0].where).toEqual({ teamId: { in: [] } });
      });
    });

    describe("createAnalysisAutomation", () => {
      it("member analyst can create for their team", async () => {
        const prisma = makePrisma();
        const res = await analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput("team-a") }, ctx(analyst, prisma));
        expect(res.teamId).toBe("team-a");
      });

      it("non-member analyst is FORBIDDEN", async () => {
        const prisma = makePrisma();
        await expect(
          analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput("team-b") }, ctx(analyst, prisma)),
        ).rejects.toThrow(/not a member/i);
        expect(au(prisma).create).not.toHaveBeenCalled();
      });

      it("team-less (system) automation is admin-only", async () => {
        const prisma = makePrisma();
        await expect(
          analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput(null) }, ctx(analyst, prisma)),
        ).rejects.toThrow(/platform admin/i);
        expect(au(prisma).create).not.toHaveBeenCalled();
      });

      it("admin bypasses membership (any team, or none)", async () => {
        const prisma = makePrisma();
        await analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput("team-b") }, ctx(admin, prisma));
        await analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput(null) }, ctx(admin, prisma));
        expect(au(prisma).create).toHaveBeenCalledTimes(2);
      });

      it("viewer is still rejected by the role gate", async () => {
        await expect(
          analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput("team-a") }, ctx(viewer)),
        ).rejects.toThrow(/insufficient permissions/i);
      });
    });

    describe("update / delete by id", () => {
      const cases = [
        ["updateAnalysisAutomation", (c: Context) =>
          analysisResolvers.Mutation.updateAnalysisAutomation(null, { id: "au-1", input: { enabled: false } }, c)],
        ["deleteAnalysisAutomation", (c: Context) =>
          analysisResolvers.Mutation.deleteAnalysisAutomation(null, { id: "au-1" }, c)],
      ] as const;
      const writeFn = (prisma: Record<string, unknown>, name: string) =>
        name === "updateAnalysisAutomation" ? au(prisma).update : au(prisma).delete;

      for (const [name, call] of cases) {
        describe(name, () => {
          it("missing id is NOT_FOUND", async () => {
            const prisma = makePrisma();
            await expect(call(ctx(analyst, prisma))).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
            expect(writeFn(prisma, name)).not.toHaveBeenCalled();
          });

          it("member of the owning team is allowed", async () => {
            const prisma = makePrisma();
            au(prisma).findUnique.mockResolvedValue({ teamId: "team-a" });
            await call(ctx(analyst, prisma));
            expect(writeFn(prisma, name)).toHaveBeenCalledOnce();
          });

          it("non-member is FORBIDDEN", async () => {
            const prisma = makePrisma();
            au(prisma).findUnique.mockResolvedValue({ teamId: "team-b" });
            await expect(call(ctx(analyst, prisma))).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
            expect(writeFn(prisma, name)).not.toHaveBeenCalled();
          });

          it("null-team (system) automation is admin-only", async () => {
            const prisma = makePrisma();
            au(prisma).findUnique.mockResolvedValue({ teamId: null });
            await expect(call(ctx(analyst, prisma))).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
            expect(writeFn(prisma, name)).not.toHaveBeenCalled();
          });

          it("admin bypasses membership", async () => {
            const prisma = makePrisma();
            au(prisma).findUnique.mockResolvedValue({ teamId: null });
            await call(ctx(admin, prisma));
            au(prisma).findUnique.mockResolvedValue({ teamId: "team-b" });
            await call(ctx(admin, prisma));
            expect(writeFn(prisma, name)).toHaveBeenCalledTimes(2);
          });
        });
      }
    });

    describe("requestAnalysis — team attribution", () => {
      const input = (teamId?: string | null) => ({
        locationIds: ["a"], windowStart: new Date("2026-01-01"), teamId,
      });
      const rq = (prisma: Record<string, unknown>) => prisma.analysisRequest as Record<string, Fn>;

      it("member can request for their team", async () => {
        const prisma = makePrisma();
        const res = await analysisResolvers.Mutation.requestAnalysis(null, { input: input("team-a") }, ctx(analyst, prisma));
        expect(res.teamId).toBe("team-a");
      });

      it("non-member is FORBIDDEN", async () => {
        const prisma = makePrisma();
        await expect(
          analysisResolvers.Mutation.requestAnalysis(null, { input: input("team-b") }, ctx(analyst, prisma)),
        ).rejects.toThrow(/not a member/i);
        expect(rq(prisma).create).not.toHaveBeenCalled();
      });

      it("team-less request stays open to analysts", async () => {
        const prisma = makePrisma();
        await analysisResolvers.Mutation.requestAnalysis(null, { input: input(null) }, ctx(analyst, prisma));
        expect(rq(prisma).create).toHaveBeenCalledOnce();
      });

      it("admin bypasses membership", async () => {
        const prisma = makePrisma();
        await analysisResolvers.Mutation.requestAnalysis(null, { input: input("team-b") }, ctx(admin, prisma));
        expect(rq(prisma).create).toHaveBeenCalledOnce();
      });
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
