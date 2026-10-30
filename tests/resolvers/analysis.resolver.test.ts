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

// AnalysisAutomation.documents presigns each row's S3 key via a dynamic import.
vi.mock("../../src/services/s3.js", () => ({
  getPresignedUrl: vi.fn(async (key: string) => `https://signed/${key}`),
}));

import { analysisResolvers } from "../../src/resolvers/analysis.resolver.js";
import type { Context } from "../../src/context.js";

function makePrisma(overrides: Record<string, unknown> = {}) {
  const analysis = {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "an-1", ...data })),
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
  // Membership fixture: `u-analyst` is a team `analyst` on team-a (the elevated
  // team role that replaces the old global analyst); `u-viewer` is a plain
  // team_member on team-a.
  const MEMBERSHIPS: Record<string, Record<string, string>> = {
    "u-analyst": { "team-a": "analyst" },
    "u-viewer": { "team-a": "team_member" },
    // An emergency_response_manager is granted the analyst permission set too.
    "u-erm": { "team-a": "emergency_response_manager" },
  };
  const teamMembers = {
    findUnique: vi.fn(async ({ where }: { where: { teamId_userId: { teamId: string; userId: string } } }) => {
      const { teamId, userId } = where.teamId_userId;
      const role = MEMBERSHIPS[userId]?.[teamId];
      return role ? { teamId, userId, role } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
      Object.keys(MEMBERSHIPS[where.userId] ?? {}).map((teamId) => ({ teamId })),
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
// A team `analyst` (global member + analyst membership on team-a); carries the
// elevated, team-scoped powers that replaced the old global analyst role.
const analyst = { id: "u-analyst", role: "member" };
// A plain team member on team-a (global member).
const viewer = { id: "u-viewer", role: "member" };

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

    it("rejects a plain member with FORBIDDEN", async () => {
      await expect(
        analysisResolvers.Mutation.upsertAnalysis(null, { input: input() }, ctx(viewer)),
      ).rejects.toThrow(/insufficient permissions/i);
    });

    it("rejects a team analyst (write is admin/pipeline only)", async () => {
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
      expect(res).toEqual({ analysisId: "an-9", supersededPrevious: true, skipped: false, reason: null });
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

  describe("regeneration gate — 24h floor + lastSyncedAt + force (ADR-0008)", () => {
    const upInput = (over: Record<string, unknown> = {}) => ({
      locationIds: ["a"], eventTypes: [], needSectors: [],
      windowStart: new Date("2026-01-01"), windowEnd: new Date("2026-12-31"),
      data: {}, sourceReportIds: [], generatedByModel: "m", schemaVersion: "v4", ...over,
    });
    const a = (p: Record<string, unknown>) => p.analysis as Record<string, ReturnType<typeof vi.fn>>;

    it("no-ops within 24h: bumps lastSyncedAt, writes no new version", async () => {
      const prisma = makePrisma();
      a(prisma).findFirst.mockResolvedValue({ id: "an-cur", generatedAt: new Date(Date.now() - 3_600_000) } as never);
      const res = await analysisResolvers.Mutation.upsertAnalysis(null, { input: upInput() }, ctx(pipeline, prisma));
      expect(res).toEqual({ analysisId: "an-cur", supersededPrevious: false, skipped: true, reason: "within-24h-floor" });
      expect(a(prisma).update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "an-cur" }, data: expect.objectContaining({ lastSyncedAt: expect.any(Date) }) }),
      );
      expect(a(prisma).create).not.toHaveBeenCalled();
      expect(a(prisma).updateMany).not.toHaveBeenCalled();
    });

    it("regenerates within 24h when forced", async () => {
      const prisma = makePrisma();
      a(prisma).findFirst.mockResolvedValue({ id: "an-cur", generatedAt: new Date() } as never);
      const res = await analysisResolvers.Mutation.upsertAnalysis(null, { input: upInput({ force: true }) }, ctx(pipeline, prisma));
      expect(res.skipped).toBe(false);
      expect(a(prisma).create).toHaveBeenCalled();
    });

    it("regenerates past the floor and stamps lastSyncedAt on the new row", async () => {
      const prisma = makePrisma();
      a(prisma).findFirst.mockResolvedValue({ id: "an-cur", generatedAt: new Date(Date.now() - 48 * 3_600_000) } as never);
      const res = await analysisResolvers.Mutation.upsertAnalysis(null, { input: upInput() }, ctx(pipeline, prisma));
      expect(res.skipped).toBe(false);
      expect(a(prisma).create.mock.calls[0][0].data.lastSyncedAt).toEqual(expect.any(Date));
    });

    it("first-ever generation (no current row) proceeds", async () => {
      const prisma = makePrisma(); // findFirst → null by default
      const res = await analysisResolvers.Mutation.upsertAnalysis(null, { input: upInput() }, ctx(pipeline, prisma));
      expect(res.skipped).toBe(false);
      expect(a(prisma).create).toHaveBeenCalled();
    });
  });

  describe("touchAnalysisSynced (ADR-0008)", () => {
    const frame = { locationIds: ["a"], windowStart: new Date("2026-01-01"), windowEnd: new Date("2026-12-31") };
    it("requires admin/pipeline", async () => {
      await expect(
        analysisResolvers.Mutation.touchAnalysisSynced(null, { frame }, ctx(analyst)),
      ).rejects.toThrow(/insufficient permissions/i);
    });
    it("bumps lastSyncedAt on the current row; true when matched", async () => {
      const prisma = makePrisma();
      (prisma.analysis as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockResolvedValue({ count: 1 });
      const res = await analysisResolvers.Mutation.touchAnalysisSynced(null, { frame }, ctx(pipeline, prisma));
      expect(res).toBe(true);
      const call = (prisma.analysis as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mock.calls[0][0];
      expect(call.where.validTo).toBeNull();
      expect(call.data.lastSyncedAt).toEqual(expect.any(Date));
    });
    it("false when no current row matches", async () => {
      const prisma = makePrisma();
      (prisma.analysis as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockResolvedValue({ count: 0 });
      expect(await analysisResolvers.Mutation.touchAnalysisSynced(null, { frame }, ctx(pipeline, prisma))).toBe(false);
    });
  });

  describe("frameEvidenceWatermark (ADR-0008)", () => {
    const frame = { locationIds: ["sudan-a0"], windowStart: new Date("2026-01-01"), windowEnd: new Date("2026-12-31") };

    it("requires admin/pipeline", async () => {
      await expect(
        analysisResolvers.Query.frameEvidenceWatermark(null, { frame }, ctx(viewer)),
      ).rejects.toThrow(/insufficient permissions/i);
    });
    it("returns max created_at + count across both tiers; single-location frame expands to subtree", async () => {
      // Two-tier watermark (#1067): the resolver queries knowledgebase (reports)
      // then events_index (events). Return a report tier (count 7) and an event
      // tier (count 3, later timestamp) so we can assert the combine.
      const reportsAt = new Date("2026-05-01");
      const eventsAt = new Date("2026-06-10");
      const queryRaw = vi
        .fn()
        .mockResolvedValueOnce([{ latestEvidenceAt: reportsAt, evidenceCount: 7 }])
        .mockResolvedValueOnce([{ latestEvidenceAt: eventsAt, evidenceCount: 3 }]);
      const prisma = makePrisma({ $queryRawUnsafe: queryRaw });
      const res = await analysisResolvers.Query.frameEvidenceWatermark(null, { frame }, ctx(pipeline, prisma));
      // Combined = the later timestamp + summed count; per-tier breakdown preserved.
      expect(res).toEqual({
        latestEvidenceAt: eventsAt,
        evidenceCount: 10,
        reportsLatestEvidenceAt: reportsAt,
        reportsCount: 7,
        eventsLatestEvidenceAt: eventsAt,
        eventsCount: 3,
      });
      const reportSql = queryRaw.mock.calls[0][0] as string;
      const eventSql = queryRaw.mock.calls[1][0] as string;
      expect(reportSql).toContain('FROM "knowledgebase"');
      expect(eventSql).toContain('FROM "events_index"');
      expect(reportSql).toContain("ancestor_ids"); // single A0 → subtree expansion
      // Freshness counts all ingestion regardless of embedding model — so neither
      // query depends on EMBEDDING_* config (no embedding_provider filter).
      expect(reportSql).not.toContain("embedding_provider");
      expect(eventSql).not.toContain("embedding_provider");
    });
  });

  describe("requestAnalysis — always forces (manual triggers bypass the 24h floor, ADR-0008)", () => {
    const input = (force?: boolean, teamId?: string) => ({
      locationIds: ["a"], windowStart: new Date("2026-01-01"), windowEnd: new Date("2026-06-30"),
      ...(force === undefined ? {} : { force }),
      ...(teamId === undefined ? {} : { teamId }),
    });
    it("persists force=true on a new request even when force is omitted", async () => {
      const prisma = makePrisma();
      const res = await analysisResolvers.Mutation.requestAnalysis(null, { input: input() }, ctx(admin, prisma));
      expect((res as { force?: boolean }).force).toBe(true);
      expect((prisma.analysisRequest as { create: ReturnType<typeof vi.fn> }).create.mock.calls[0][0].data.force).toBe(true);
    });
    it("forces even when the caller explicitly passes force:false (the field is ignored)", async () => {
      const prisma = makePrisma();
      await analysisResolvers.Mutation.requestAnalysis(null, { input: input(false) }, ctx(admin, prisma));
      expect((prisma.analysisRequest as { create: ReturnType<typeof vi.fn> }).create.mock.calls[0][0].data.force).toBe(true);
    });
    it("a non-admin team analyst's team-scoped request is forced (no longer rejected for forcing)", async () => {
      const prisma = makePrisma();
      const res = await analysisResolvers.Mutation.requestAnalysis(
        null, { input: input(undefined, "team-a") }, ctx(analyst, prisma),
      );
      expect((res as { force?: boolean }).force).toBe(true);
      expect((prisma.analysisRequest as { create: ReturnType<typeof vi.fn> }).create.mock.calls[0][0].data.force).toBe(true);
    });
    it("upgrades an existing non-forced PENDING to forced", async () => {
      const prisma = makePrisma();
      (prisma.analysisRequest as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockResolvedValue({
        id: "rq-x", teamId: null, requestedByUserId: null, lastError: null, force: false,
      });
      const res = await analysisResolvers.Mutation.requestAnalysis(null, { input: input() }, ctx(admin, prisma));
      expect((prisma.analysisRequest as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "rq-x" }, data: { force: true } }),
      );
      expect((res as { force?: boolean }).force).toBe(true);
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

    it("a team-less request is admin-only (a non-admin member is FORBIDDEN)", async () => {
      await expect(
        analysisResolvers.Mutation.requestAnalysis(null, { input: input() }, ctx(viewer)),
      ).rejects.toThrow(/platform admin|insufficient permissions/i);
    });

    it("returns the existing PENDING request instead of creating a duplicate", async () => {
      // input() is team-less → admin-only; drive the dedupe path as an admin.
      const prisma = makePrisma();
      // A stored PENDING is already forced (manual triggers always force now),
      // so the dedupe returns it as-is rather than upgrading it.
      (prisma.analysisRequest as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockResolvedValue({ id: "rq-existing", status: "PENDING", force: true });
      const res = await analysisResolvers.Mutation.requestAnalysis(null, { input: input() }, ctx(admin, prisma));
      expect(res).toEqual({ id: "rq-existing", status: "PENDING", force: true });
      expect((prisma.analysisRequest as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
    });

    it("on a create P2002 race, returns the winner", async () => {
      const prisma = makePrisma();
      const rq = prisma.analysisRequest as { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
      rq.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "rq-winner", status: "PENDING" });
      rq.create.mockRejectedValue(p2002);
      const res = await analysisResolvers.Mutation.requestAnalysis(null, { input: input() }, ctx(admin, prisma));
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
        await analysisResolvers.Query.analysisAutomations(null, {}, ctx({ id: "u-lonely", role: "member" }, prisma));
        expect(au(prisma).findMany.mock.calls[0][0].where).toEqual({ teamId: { in: [] } });
      });
    });

    describe("createAnalysisAutomation", () => {
      it("member analyst can create for their team", async () => {
        const prisma = makePrisma();
        const res = await analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput("team-a") }, ctx(analyst, prisma));
        expect(res.teamId).toBe("team-a");
      });

      it("emergency response manager can create for their team (granted the analyst permission set)", async () => {
        const prisma = makePrisma();
        const erm = { id: "u-erm", role: "member" };
        const res = await analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput("team-a") }, ctx(erm, prisma));
        expect(res.teamId).toBe("team-a");
      });

      it("non-member analyst is FORBIDDEN", async () => {
        const prisma = makePrisma();
        await expect(
          analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput("team-b") }, ctx(analyst, prisma)),
        ).rejects.toThrow(/team analyst on this automation's team/i);
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

      it("a plain team member (not a team analyst) is rejected by the team gate", async () => {
        await expect(
          analysisResolvers.Mutation.createAnalysisAutomation(null, { input: createInput("team-a") }, ctx(viewer)),
        ).rejects.toThrow(/team analyst on this automation's team/i);
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
        ).rejects.toThrow(/global admin, or team analyst/i);
        expect(rq(prisma).create).not.toHaveBeenCalled();
      });

      it("team-less request is admin-only — a team analyst is FORBIDDEN", async () => {
        // A null teamId is a platform-level request; the team-scoped analyst
        // power does not extend to it.
        const prisma = makePrisma();
        await expect(
          analysisResolvers.Mutation.requestAnalysis(null, { input: input(null) }, ctx(analyst, prisma)),
        ).rejects.toThrow(/platform admin/i);
        expect(rq(prisma).create).not.toHaveBeenCalled();
      });

      it("admin bypasses membership", async () => {
        const prisma = makePrisma();
        await analysisResolvers.Mutation.requestAnalysis(null, { input: input("team-b") }, ctx(admin, prisma));
        expect(rq(prisma).create).toHaveBeenCalledOnce();
      });
      it("dedupes onto another team's pending request without exposing its requester or error", async () => {
        const prisma = makePrisma();
        const foreign = { id: "rq-b", status: "PENDING", teamId: "team-b", requestedByUserId: "u-b", lastError: "boom", force: true };
        rq(prisma).findFirst.mockResolvedValueOnce(foreign);
        const res = await analysisResolvers.Mutation.requestAnalysis(null, { input: input("team-a") }, ctx(analyst, prisma));
        expect(res).toMatchObject({ id: "rq-b", teamId: null, requestedByUserId: null, lastError: null });
        expect(rq(prisma).create).not.toHaveBeenCalled();
      });

      it("admin sees the pending request as stored", async () => {
        const prisma = makePrisma();
        const foreign = { id: "rq-b", status: "PENDING", teamId: "team-b", requestedByUserId: "u-b", lastError: null, force: true };
        rq(prisma).findFirst.mockResolvedValueOnce(foreign);
        const res = await analysisResolvers.Mutation.requestAnalysis(null, { input: input("team-a") }, ctx(admin, prisma));
        expect(res).toMatchObject({ teamId: "team-b", requestedByUserId: "u-b" });
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

// ─── title + discussion + documents (PR #255) ──────────────────────────────

describe("analysis automation title / discussion / documents", () => {
  it("createAnalysisAutomation stores a trimmed title", async () => {
    const prisma = makePrisma();
    await analysisResolvers.Mutation.createAnalysisAutomation(
      null,
      { input: { locationIds: ["a"], eventTypes: [], needSectors: [], windowStart: new Date("2026-01-01"), cadence: "daily", title: "  Sudan floods  " } },
      ctx(admin, prisma),
    );
    const create = (prisma.analysisAutomation as { create: ReturnType<typeof vi.fn> }).create;
    expect(create.mock.calls[0][0].data.title).toBe("Sudan floods");
  });

  it("createAnalysisAutomation rejects an over-long title", async () => {
    await expect(
      analysisResolvers.Mutation.createAnalysisAutomation(
        null,
        { input: { locationIds: ["a"], eventTypes: [], needSectors: [], windowStart: new Date("2026-01-01"), cadence: "daily", title: "x".repeat(121) } },
        ctx(admin),
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("updateAnalysisAutomation writes an explicit null title to clear it", async () => {
    const prisma = makePrisma({
      analysisAutomation: {
        findUnique: vi.fn(async () => ({ teamId: null })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "au-1", ...data })),
      },
    });
    await analysisResolvers.Mutation.updateAnalysisAutomation(
      null,
      { id: "au-1", input: { title: "" } },
      ctx(admin, prisma),
    );
    const update = (prisma.analysisAutomation as { update: ReturnType<typeof vi.fn> }).update;
    expect(update.mock.calls[0][0].data.title).toBeNull();
  });

  it("AnalysisAutomation.comments reads the thread oldest-first", async () => {
    const findMany = vi.fn(async () => [{ id: "c1" }]);
    const prisma = makePrisma({ userComments: { findMany } });
    const rows = await analysisResolvers.AnalysisAutomation.comments({ id: "au-1" }, {}, ctx(admin, prisma));
    expect(rows).toEqual([{ id: "c1" }]);
    expect(findMany).toHaveBeenCalledWith({
      where: { analysisAutomationId: "au-1" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("AnalysisAutomation.documents presigns each attached file", async () => {
    const findMany = vi.fn(async () => [{ id: "d1", fileName: "r.pdf", reportId: "manual:ab", s3Key: "kb/r.pdf" }]);
    const prisma = makePrisma({ analysisAutomationDocument: { findMany } });
    const rows = await analysisResolvers.AnalysisAutomation.documents({ id: "au-1" }, {}, ctx(admin, prisma));
    expect(rows[0]).toMatchObject({ id: "d1", s3Key: "kb/r.pdf", url: "https://signed/kb/r.pdf" });
  });

  it("Query.analysisAutomation returns a system-owned automation to an admin", async () => {
    const prisma = makePrisma({
      analysisAutomation: { findUnique: vi.fn(async () => ({ id: "au-1", teamId: null })) },
    });
    const row = await analysisResolvers.Query.analysisAutomation(null, { id: "au-1" }, ctx(admin, prisma));
    expect(row).toMatchObject({ id: "au-1" });
  });
});
