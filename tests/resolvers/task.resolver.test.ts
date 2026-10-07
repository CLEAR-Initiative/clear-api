/**
 * Tests for the Task / Worker protocol resolver (ADR-0010).
 *
 * DB-FREE: `context.prisma` is a small in-memory `task` store behind
 * `vi.fn()` delegates (so conditional `updateMany` writes behave like the
 * real thing), `$transaction` runs a callback against it, and `$queryRaw`
 * (the SKIP LOCKED claim) is a stub that returns whatever ids the test
 * seeds. These assert external behaviour — who may call what, the status
 * after each mutation, what the error subCodes and messages are — never the
 * SQL text. Claim atomicity and lease expiry run against the real schema in
 * `task.db.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { GraphQLError } from "graphql";
import { Prisma } from "../../src/generated/prisma/client.js";

const notifyTaskOutcome = vi.fn(async () => undefined);
vi.mock("../../src/services/task-notifications.js", () => ({
  notifyTaskOutcome: (...args: unknown[]) => notifyTaskOutcome(...(args as [])),
}));

import { taskResolvers, IMPACT_PRIOR_KIND } from "../../src/resolvers/task.resolver.js";
import type { Context } from "../../src/context.js";

type Row = Record<string, unknown>;

/** The default fan-out (TASK_IMPACT_PRIOR_KINDS): one Task per source kind. */
const CLEAR_KIND = "event.impact_prior.clear";
const WEB_KIND = "event.impact_prior.web";
const KINDS = [CLEAR_KIND, WEB_KIND];
/** What `task.groupBy({ by: ["requestId"] })` returns for n requests today. */
const requests = (n: number) => Array.from({ length: n }, (_, i) => ({ requestId: `r-${i}` }));

function makeTask(overrides: Row = {}): Row {
  return {
    id: "t-1",
    kind: CLEAR_KIND,
    subjectType: "event",
    subjectId: "ev-1",
    payload: { horizonYears: 10 },
    status: "PENDING",
    origin: "user",
    requestId: "r-1",
    requesterId: "u-analyst",
    teamId: null,
    leaseOwnerId: null,
    leaseExpiresAt: null,
    leaseToken: null,
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
    ...overrides,
  };
}

/** A `where` of equality conditions, plus `{ lt }` on dates (what the
 *  resolver's conditional writes use), matched against a row. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "lt" in (v as object)) {
      const cell = row[k];
      return cell instanceof Date && cell < (v as { lt: Date }).lt;
    }
    return row[k] === v;
  });
}

function makePrisma(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, Row>();
  // Created rows get t-1, t-2, … in creation order (a fan-out creates several).
  let seq = 0;
  const task = {
    store,
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = store.get(where.id);
      if (!row) throw new Error("not found");
      return row;
    }),
    findFirst: vi.fn(async (_args: { where: Row }): Promise<Row | null> => null),
    findMany: vi.fn(async (): Promise<Row[]> => []),
    count: vi.fn(async () => 0),
    groupBy: vi.fn(async (): Promise<{ requestId: string }[]> => []),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = makeTask({ id: `t-${++seq}`, ...data });
      store.set(row.id as string, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = { ...(store.get(where.id) ?? makeTask({ id: where.id })), ...data };
      store.set(where.id, row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const [id, row] of store) {
        if (matches(row, where)) {
          store.set(id, { ...row, ...data });
          count++;
        }
      }
      return { count };
    }),
  };
  const priors = new Map<string, Row>();
  const impactPrior = {
    store: priors,
    findFirst: vi.fn(async (): Promise<Row | null> => null),
    findMany: vi.fn(async (): Promise<Row[]> => []),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => priors.get(where.id) ?? null),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = priors.get(where.id);
      if (!row) throw new Error("not found");
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const [id, row] of priors) {
        if (matches(row, where)) {
          priors.set(id, { ...row, ...data });
          count++;
        }
      }
      return { count };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => ({ id: "ip-1", state: "proposed", ...data })),
  };
  const cases = new Map<string, Row>();
  const caseProposal = {
    store: cases,
    findMany: vi.fn(async (): Promise<Row[]> => []),
    // Like the unique (eventId, sourceUrl) with skipDuplicates: a URL already
    // stored for the Event is skipped, not an error.
    createMany: vi.fn(async ({ data }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        const key = `${row.eventId}|${row.sourceUrl}`;
        if (cases.has(key)) continue;
        cases.set(key, { state: "proposed", ...row });
        count++;
      }
      return { count };
    }),
  };
  // ev-1 is the Event being enriched; ev-old a past flood in the same
  // country; ev-abroad one in another country.
  const EVENTS: Record<string, Row> = {
    "ev-1": { id: "ev-1", types: ["FL", "FF"], locationId: "loc-district", originId: null, destinationId: null },
    "ev-old": { id: "ev-old", types: ["FL"], locationId: "loc-state", originId: null, destinationId: null },
    "ev-abroad": { id: "ev-abroad", types: ["FL"], locationId: "loc-abroad", originId: null, destinationId: null },
  };
  const events = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => EVENTS[where.id] ?? null),
  };
  // loc-district (level 2) → loc-state (1) → loc-country (0).
  const LOCATIONS: Record<string, Row> = {
    "loc-district": { id: "loc-district", level: 2, ancestorIds: ["loc-state", "loc-country"] },
    "loc-state": { id: "loc-state", level: 1, ancestorIds: ["loc-country"] },
    "loc-country": { id: "loc-country", level: 0, ancestorIds: [] },
    "loc-abroad": { id: "loc-abroad", level: 0, ancestorIds: [] },
  };
  const locations = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => LOCATIONS[where.id] ?? null),
    findFirst: vi.fn(async ({ where }: { where: { id: { in: string[] }; level: number } }) =>
      Object.values(LOCATIONS).find((l) => where.id.in.includes(l.id as string) && l.level === where.level) ?? null,
    ),
    findMany: vi.fn(async () => []),
  };
  const activityLogs = { create: vi.fn(async () => ({})) };
  // Membership fixture: the coordinator belongs to team-a only.
  const MEMBERSHIPS: Record<string, Record<string, string>> = {
    "u-coord": { "team-a": "field_coordinator" },
  };
  const teamMembers = {
    findUnique: vi.fn(
      async ({ where }: { where: { teamId_userId: { teamId: string; userId: string } } }) => {
        const { teamId, userId } = where.teamId_userId;
        const role = MEMBERSHIPS[userId]?.[teamId];
        return role ? { teamId, userId, role } : null;
      },
    ),
  };
  const prisma: Record<string, unknown> = {
    task, impactPrior, caseProposal, events, locations, activityLogs, teamMembers,
    $queryRaw: vi.fn(async () => [] as { id: string }[]),
    $executeRaw: vi.fn(async () => 0),
  };
  prisma.$transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
  Object.assign(prisma, overrides);
  return prisma as typeof prisma & {
    task: typeof task; impactPrior: typeof impactPrior; caseProposal: typeof caseProposal; events: typeof events;
    activityLogs: typeof activityLogs; $queryRaw: ReturnType<typeof vi.fn>;
  };
}

/** Seed rows into the store and return the prisma. */
function seeded(...rows: Row[]) {
  const prisma = makePrisma();
  for (const r of rows) prisma.task.store.set(r.id as string, r);
  return prisma;
}

type User = { id: string; role: string };
function ctx(
  user: User | null,
  prisma = makePrisma(),
  authMethod: "session" | "api-key" = "session",
): Context {
  return {
    prisma, user, session: null, authMethod: user ? authMethod : null, locale: "en",
  } as unknown as Context;
}

const admin: User = { id: "u-admin", role: "admin" };
const analyst: User = { id: "u-analyst", role: "analyst" };
const viewer: User = { id: "u-viewer", role: "viewer" };
const coordinator: User = { id: "u-coord", role: "viewer" };
const worker: User = { id: "u-worker", role: "worker" };
const rivalWorker: User = { id: "u-worker-2", role: "worker" };
const pipeline: User = { id: "u-pipe", role: "pipeline" };

const { requestEventEnrichment, claimTasks, heartbeatTask, completeTask, failTask, cancelTask, decideImpactPrior } =
  taskResolvers.Mutation;
const { leaseToken: leaseTokenField } = taskResolvers.Task;
const {
  task: taskQuery, eventTasks, eventImpactPriors, impactPriors: impactPriorsQuery, myTasks,
  caseProposals: caseProposalsQuery, eventCaseProposals, rejectedCaseUrls,
} = taskResolvers.Query;

const TOKEN = "tok-1";
const leased = (overrides: Row = {}) =>
  makeTask({ status: "LEASED", leaseOwnerId: "u-worker", leaseToken: TOKEN, attempts: 1, leaseExpiresAt: new Date("2026-10-06T10:15:00Z"), ...overrides });

async function errorOf(p: Promise<unknown>): Promise<GraphQLError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GraphQLError) return e;
    throw e;
  }
  throw new Error("expected a GraphQLError");
}

afterEach(() => {
  vi.useRealTimers();
  notifyTaskOutcome.mockClear();
});

describe("notification fan-out (V2)", () => {
  it("fires on completion with the committed Task", async () => {
    const prisma = seeded(leased());
    await completeTask(null, { id: "t-1", leaseToken: TOKEN, result: {} }, ctx(worker, prisma));
    expect(notifyTaskOutcome).toHaveBeenCalledWith(prisma, expect.objectContaining({ id: "t-1", status: "COMPLETED", outcome: "no_prior_found" }), "completed");
  });

  it("fires on a terminal failure but not on a retry", async () => {
    const retry = seeded(leased({ attempts: 1 }));
    await failTask(null, { id: "t-1", leaseToken: TOKEN, error: "x" }, ctx(worker, retry));
    expect(notifyTaskOutcome).not.toHaveBeenCalled();
    const last = seeded(leased({ attempts: 3 }));
    await failTask(null, { id: "t-1", leaseToken: TOKEN, error: "gave up" }, ctx(worker, last));
    expect(notifyTaskOutcome).toHaveBeenCalledWith(last, expect.objectContaining({ status: "FAILED", lastError: "gave up" }), "failed");
  });

  it("does not fire when a cancel wins", async () => {
    const prisma = seeded(leased({ cancelRequestedAt: new Date("2026-10-06T10:05:00Z") }));
    await completeTask(null, { id: "t-1", leaseToken: TOKEN, result: {} }, ctx(worker, prisma));
    expect(notifyTaskOutcome).not.toHaveBeenCalled();
  });

  it("fires for Tasks the claim sweep marks FAILED", async () => {
    const prisma = seeded(makeTask({ id: "t-old", status: "FAILED", lastError: "lease expired after max attempts" }));
    prisma.$queryRaw.mockResolvedValueOnce([{ id: "t-old" }]).mockResolvedValueOnce([]);
    prisma.task.findMany.mockResolvedValueOnce([prisma.task.store.get("t-old")!]);
    await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, ctx(worker, prisma));
    expect(notifyTaskOutcome).toHaveBeenCalledWith(prisma, expect.objectContaining({ id: "t-old" }), "failed");
  });
});

describe("requestEventEnrichment", () => {
  describe("gate — the same as escalateEvent", () => {
    it.each([
      ["admin", admin, undefined],
      ["analyst", analyst, undefined],
      ["team field_coordinator with their teamId", coordinator, "team-a"],
    ])("allows a %s", async (_name, user, teamId) => {
      const prisma = makePrisma();
      const result = await requestEventEnrichment(null, { eventId: "ev-1", teamId }, ctx(user, prisma));
      expect(result.map((t) => t.kind)).toEqual(KINDS);
      expect(result.every((t) => t.subjectType === "event" && t.subjectId === "ev-1")).toBe(true);
      expect(prisma.task.create).toHaveBeenCalledTimes(KINDS.length);
    });

    it.each([
      ["a viewer with no team", viewer, undefined],
      ["a team member of another team", coordinator, "team-b"],
      ["a worker", worker, undefined],
    ])("rejects %s with FORBIDDEN", async (_name, user, teamId) => {
      const prisma = makePrisma();
      const err = await errorOf(requestEventEnrichment(null, { eventId: "ev-1", teamId }, ctx(user, prisma)));
      expect(err.extensions.code).toBe("FORBIDDEN");
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it("rejects an unauthenticated caller", async () => {
      const err = await errorOf(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(null)));
      expect(err.extensions.code).toBe("UNAUTHENTICATED");
    });
  });

  describe("fan-out — one Task per enabled source kind (TASK_IMPACT_PRIOR_KINDS, default .clear and .web)", () => {
    it("creates one Task per kind, in configured order, all sharing one requestId", async () => {
      const prisma = makePrisma();
      const result = await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      expect(result.map((t) => t.kind)).toEqual(KINDS);
      expect(result.map((t) => t.id)).toEqual(["t-1", "t-2"]);
      const requestIds = new Set(result.map((t) => t.requestId));
      expect(requestIds.size).toBe(1);
      expect([...requestIds][0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.every((t) => t.status === "PENDING")).toBe(true);
    });

    it("records the CALLER as requester and the view-scope team on every Task", async () => {
      const prisma = makePrisma();
      await requestEventEnrichment(null, { eventId: "ev-1", teamId: "team-a" }, ctx(coordinator, prisma));
      expect(prisma.task.create).toHaveBeenCalledTimes(2);
      for (const kind of KINDS) {
        expect(prisma.task.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ kind, requesterId: "u-coord", teamId: "team-a" }),
        });
      }
    });

    it("stores the horizon in every payload, defaulting to 10 years", async () => {
      const prisma = makePrisma();
      await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      for (const call of prisma.task.create.mock.calls) {
        expect(call[0].data).toMatchObject({ payload: { horizonYears: 10 } });
      }
      prisma.task.create.mockClear();
      await requestEventEnrichment(null, { eventId: "ev-1", horizonYears: 5 }, ctx(analyst, prisma));
      for (const call of prisma.task.create.mock.calls) {
        expect(call[0].data).toMatchObject({ payload: { horizonYears: 5 } });
      }
    });

    it("never picks a source: a per-source kind as the argument is BAD_USER_INPUT naming the family", async () => {
      const prisma = makePrisma();
      const err = await errorOf(requestEventEnrichment(null, { eventId: "ev-1", kind: WEB_KIND }, ctx(analyst, prisma)));
      expect(err.extensions.code).toBe("BAD_USER_INPUT");
      expect(err.message).toContain(IMPACT_PRIOR_KIND);
      expect(prisma.task.create).not.toHaveBeenCalled();
    });
  });

  describe("dedupe — one open Task per Event and kind", () => {
    const openFor = (kind: string, row: Row) => async ({ where }: { where: Row }) => (where.kind === kind ? row : null);

    it.each(["PENDING", "LEASED"])("returns the existing %s Task of a kind unchanged and creates only the kinds with none", async (status) => {
      const prisma = makePrisma();
      const open = makeTask({ id: "t-open", kind: CLEAR_KIND, status, requesterId: "u-someone-else", payload: { horizonYears: 3 } });
      prisma.task.findFirst.mockImplementation(openFor(CLEAR_KIND, open));
      const result = await requestEventEnrichment(null, { eventId: "ev-1", horizonYears: 10 }, ctx(analyst, prisma));
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(open);
      expect(result[1]).toMatchObject({ kind: WEB_KIND, status: "PENDING", payload: { horizonYears: 10 } });
      expect(prisma.task.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          kind: CLEAR_KIND, subjectType: "event", subjectId: "ev-1",
          status: { in: ["PENDING", "LEASED"] },
        }),
      });
      expect(prisma.task.create).toHaveBeenCalledTimes(1);
      expect(prisma.task.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: WEB_KIND }) });
    });

    it("creates nothing, checks no cap and logs nothing when every kind already has an open Task", async () => {
      const prisma = makePrisma();
      prisma.task.findFirst.mockImplementation(async ({ where }) => makeTask({ id: `open-${where.kind}`, kind: where.kind }));
      const result = await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      expect(result.map((t) => t.id)).toEqual(KINDS.map((k) => `open-${k}`));
      expect(prisma.task.create).not.toHaveBeenCalled();
      expect(prisma.task.groupBy).not.toHaveBeenCalled();
      expect(prisma.activityLogs.create).not.toHaveBeenCalled();
    });

    it("returns the winner when the partial unique index rejects a concurrent create, and still creates the other kinds", async () => {
      const prisma = makePrisma();
      const winner = makeTask({ id: "t-winner", kind: CLEAR_KIND });
      // The dedupe pass finds nothing for either kind; the re-read after P2002 on .clear finds the winner.
      prisma.task.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      prisma.task.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      const result = await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      expect(result[0]).toEqual(winner);
      expect(result[1]).toMatchObject({ kind: WEB_KIND, status: "PENDING" });
      expect(prisma.task.create).toHaveBeenCalledTimes(2);
    });

    it("redacts the open Task's lastError for a different requester, on both dedupe paths", async () => {
      const open = makeTask({ id: "t-open", kind: CLEAR_KIND, requesterId: "u-someone-else", lastError: "attempt 1 failed" });
      const prisma = makePrisma();
      prisma.task.findFirst.mockImplementation(openFor(CLEAR_KIND, open));
      expect((await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma)))[0].lastError).toBeNull();
      expect((await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(admin, prisma)))[0].lastError).toBe("attempt 1 failed");
      expect((await requestEventEnrichment(null, { eventId: "ev-1" }, ctx({ id: "u-someone-else", role: "analyst" }, prisma)))[0].lastError).toBe("attempt 1 failed");

      const racing = makePrisma();
      racing.task.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(open);
      racing.task.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      expect((await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, racing)))[0].lastError).toBeNull();
    });

    it("creates every missing kind in one transaction — a failure midway leaves no half-created request", async () => {
      const prisma = makePrisma();
      await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.task.create).toHaveBeenCalledTimes(2);
      // The transaction rolls back on any failure, so the first kind never lands alone.
      const failing = makePrisma();
      failing.task.create.mockImplementationOnce(async ({ data }: { data: Row }) => makeTask({ id: "t-x", ...data }))
        .mockRejectedValueOnce(new Error("connection lost"));
      await expect(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, failing))).rejects.toThrow("connection lost");
      expect(failing.$transaction).toHaveBeenCalledTimes(1);
      expect(failing.activityLogs.create).not.toHaveBeenCalled();
    });

    it("rethrows any other create failure", async () => {
      const prisma = makePrisma();
      prisma.task.create.mockRejectedValueOnce(new Error("connection lost"));
      await expect(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma))).rejects.toThrow("connection lost");
    });

    it("gives up with CONFLICT when the winner keeps vanishing before it can be read back", async () => {
      const prisma = makePrisma();
      prisma.task.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      const err = await errorOf(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma)));
      expect(err.extensions.code).toBe("CONFLICT");
      expect(err.message).toMatch(/retry/);
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });
  });

  describe("per-requester daily cap (TASK_REQUEST_DAILY_CAP, default 20) — counts requests, not Tasks", () => {
    it("counts the caller's distinct requests since UTC midnight, never Task rows", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-06T15:30:00Z"));
      const prisma = makePrisma();
      await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      expect(prisma.task.groupBy).toHaveBeenCalledWith({
        by: ["requestId"],
        where: { requesterId: "u-analyst", createdAt: { gte: new Date("2026-10-06T00:00:00Z") } },
      });
      expect(prisma.task.count).not.toHaveBeenCalled();
    });

    it("allows the 20th request and rejects the 21st with FORBIDDEN / DAILY_CAP naming the cap", async () => {
      const prisma = makePrisma();
      // 19 requests today — 38 Task rows, which must not be what is counted.
      prisma.task.groupBy.mockResolvedValueOnce(requests(19));
      await expect(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma))).resolves.toHaveLength(2);
      prisma.task.groupBy.mockResolvedValueOnce(requests(20));
      const err = await errorOf(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma)));
      expect(err.extensions).toMatchObject({ code: "FORBIDDEN", subCode: "DAILY_CAP" });
      expect(err.message).toContain("20");
      expect(prisma.task.create).toHaveBeenCalledTimes(2);
    });

    it("applies to admins too, and to API-key callers", async () => {
      const prisma = makePrisma();
      prisma.task.groupBy.mockResolvedValue(requests(20));
      const a = await errorOf(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(admin, prisma)));
      expect(a.extensions.subCode).toBe("DAILY_CAP");
      const b = await errorOf(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma, "api-key")));
      expect(b.extensions.subCode).toBe("DAILY_CAP");
    });

    it("does not apply when the request dedupes onto open Tasks for every kind", async () => {
      const prisma = makePrisma();
      prisma.task.findFirst.mockImplementation(async ({ where }) => makeTask({ id: `open-${where.kind}`, kind: where.kind }));
      prisma.task.groupBy.mockResolvedValue(requests(20));
      const result = await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      expect(result.map((t) => t.id)).toEqual(KINDS.map((k) => `open-${k}`));
      expect(prisma.task.groupBy).not.toHaveBeenCalled();
    });

    it("applies when only some kinds need a Task — a request that creates anything is a request", async () => {
      const prisma = makePrisma();
      prisma.task.findFirst.mockImplementation(async ({ where }) => (where.kind === CLEAR_KIND ? makeTask({ id: "t-open" }) : null));
      prisma.task.groupBy.mockResolvedValue(requests(20));
      const err = await errorOf(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma)));
      expect(err.extensions.subCode).toBe("DAILY_CAP");
      expect(prisma.task.create).not.toHaveBeenCalled();
    });
  });

  describe("origin", () => {
    it("is `user` for a session and `api` for an API key", async () => {
      const prisma = makePrisma();
      await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma, "session"));
      expect(prisma.task.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ origin: "user" }) });
      await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma, "api-key"));
      expect(prisma.task.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ origin: "api" }) });
    });
  });

  it("logs task.requested once per created Task, against the caller, with the shared requestId", async () => {
    const prisma = makePrisma();
    const [first, second] = await requestEventEnrichment(null, { eventId: "ev-1", teamId: "team-a" }, ctx(coordinator, prisma));
    // logActivity is fire-and-forget; let it settle.
    await new Promise((r) => setImmediate(r));
    expect(prisma.activityLogs.create).toHaveBeenCalledTimes(2);
    for (const task of [first, second]) {
      expect(prisma.activityLogs.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "u-coord",
          action: "task.requested",
          resourceType: "task",
          resourceId: task.id,
          metadata: expect.objectContaining({ kind: task.kind, requestId: first.requestId, subjectId: "ev-1", teamId: "team-a" }),
        }),
      });
    }
  });

  it("is NOT_FOUND for a missing Event", async () => {
    const err = await errorOf(requestEventEnrichment(null, { eventId: "ev-missing" }, ctx(analyst)));
    expect(err.extensions.code).toBe("NOT_FOUND");
  });

  it.each([
    ["an unknown kind", { kind: "event.something_else" }],
    ["a zero horizon", { horizonYears: 0 }],
    ["a fractional horizon", { horizonYears: 2.5 }],
  ])("is BAD_USER_INPUT for %s", async (_name, extra) => {
    const err = await errorOf(requestEventEnrichment(null, { eventId: "ev-1", ...extra }, ctx(analyst)));
    expect(err.extensions.code).toBe("BAD_USER_INPUT");
  });
});

describe("claimTasks", () => {
  it.each([
    ["admin", admin],
    ["analyst", analyst],
    ["pipeline", pipeline],
    ["viewer", viewer],
  ])("is FORBIDDEN for a %s — only the worker role claims", async (_name, user) => {
    const prisma = makePrisma();
    const err = await errorOf(claimTasks(null, { kind: IMPACT_PRIOR_KIND }, ctx(user, prisma)));
    expect(err.extensions.code).toBe("FORBIDDEN");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns the leased rows in claim order", async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "t-2" }, { id: "t-1" }]);
    prisma.task.findMany.mockResolvedValueOnce([
      makeTask({ id: "t-1", status: "LEASED", leaseOwnerId: "u-worker" }),
      makeTask({ id: "t-2", status: "LEASED", leaseOwnerId: "u-worker" }),
    ]);
    const rows = await claimTasks(null, { kind: IMPACT_PRIOR_KIND, limit: 2 }, ctx(worker, prisma));
    expect(rows.map((r) => r.id)).toEqual(["t-2", "t-1"]);
    expect(rows.every((r) => r.status === "LEASED" && r.leaseOwnerId === "u-worker")).toBe(true);
  });

  it("returns an empty list when nothing is claimable, without a second read", async () => {
    const prisma = makePrisma();
    const rows = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, ctx(worker, prisma));
    expect(rows).toEqual([]);
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });
});

describe("lease ownership — heartbeat and complete", () => {
  it.each([
    ["heartbeatTask", (c: Context) => heartbeatTask(null, { id: "t-1", leaseToken: TOKEN }, c)],
    ["completeTask", (c: Context) => completeTask(null, { id: "t-1", leaseToken: TOKEN, result: {} }, c)],
    ["failTask", (c: Context) => failTask(null, { id: "t-1", leaseToken: TOKEN, error: "x" }, c)],
  ])("%s is FORBIDDEN for any non-worker role, even an admin", async (_name, call) => {
    const err = await errorOf(call(ctx(admin, seeded(leased()))));
    expect(err.extensions.code).toBe("FORBIDDEN");
  });

  it.each([
    ["heartbeatTask", (c: Context) => heartbeatTask(null, { id: "t-nope" }, c)],
    ["completeTask", (c: Context) => completeTask(null, { id: "t-nope", leaseToken: TOKEN, result: {} }, c)],
    ["failTask", (c: Context) => failTask(null, { id: "t-nope", leaseToken: TOKEN, error: "x" }, c)],
  ])("%s is NOT_FOUND for an unknown Task", async (_name, call) => {
    const err = await errorOf(call(ctx(worker)));
    expect(err.extensions.code).toBe("NOT_FOUND");
  });

  it.each(["PENDING", "COMPLETED", "FAILED", "CANCELLED"])(
    "is CONFLICT NOT_LEASED when the Task is %s",
    async (status) => {
      const prisma = seeded(makeTask({ status, leaseOwnerId: "u-worker" }));
      const err = await errorOf(heartbeatTask(null, { id: "t-1", leaseToken: TOKEN }, ctx(worker, prisma)));
      expect(err.extensions).toMatchObject({ code: "CONFLICT", subCode: "NOT_LEASED" });
      expect(err.message).toContain(status);
    },
  );

  it("is FORBIDDEN NOT_LEASE_OWNER for a worker that does not hold the lease, and writes nothing", async () => {
    const prisma = seeded(leased());
    const err = await errorOf(completeTask(null, { id: "t-1", leaseToken: TOKEN, result: {} }, ctx(rivalWorker, prisma)));
    expect(err.extensions).toMatchObject({ code: "FORBIDDEN", subCode: "NOT_LEASE_OWNER" });
    expect(prisma.task.store.get("t-1")!.status).toBe("LEASED");
  });

  it("a lease reclaimed between the check and the write is not overwritten (NOT_LEASE_OWNER)", async () => {
    const prisma = seeded(leased());
    // The pre-check sees worker A as owner; by the time of the write, B holds it.
    prisma.task.findUnique.mockImplementationOnce(async () => leased());
    prisma.task.store.set("t-1", leased({ leaseOwnerId: "u-worker-2", attempts: 2 }));
    const err = await errorOf(heartbeatTask(null, { id: "t-1", leaseToken: TOKEN }, ctx(worker, prisma)));
    expect(err.extensions.subCode).toBe("NOT_LEASE_OWNER");
    expect(prisma.task.store.get("t-1")).toMatchObject({ leaseOwnerId: "u-worker-2", attempts: 2 });
  });
});

describe("heartbeatTask", () => {
  it("extends the lease by TASK_LEASE_MINUTES (15) from now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:10:00Z"));
    const prisma = seeded(leased());
    const row = await heartbeatTask(null, { id: "t-1", leaseToken: TOKEN }, ctx(worker, prisma));
    expect(row).toMatchObject({ status: "LEASED", leaseOwnerId: "u-worker", attempts: 1 });
    expect(row.leaseExpiresAt).toEqual(new Date("2026-10-06T10:25:00Z"));
  });

  it("still extends a lapsed lease the owner has not lost yet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:30:00Z"));
    const prisma = seeded(leased({ leaseExpiresAt: new Date("2026-10-06T10:15:00Z") }));
    const row = await heartbeatTask(null, { id: "t-1", leaseToken: TOKEN }, ctx(worker, prisma));
    expect(row.leaseExpiresAt).toEqual(new Date("2026-10-06T10:45:00Z"));
  });
});

describe("completeTask", () => {
  it("marks the Task COMPLETED with the raw result, keeping who completed it", async () => {
    const prisma = seeded(leased());
    const done = await completeTask(null, { id: "t-1", leaseToken: TOKEN, result: { cases: 1 } }, ctx(worker, prisma));
    expect(done).toMatchObject({
      status: "COMPLETED",
      result: { cases: 1 },
      leaseOwnerId: "u-worker",
      leaseExpiresAt: null,
    });
    expect(done.completedAt).toBeInstanceOf(Date);
  });

  it("with an impactPrior inserts a proposed row linked to the Event and Task, outcome produced", async () => {
    const prisma = seeded(leased());
    const done = await completeTask(
      null,
      {
        id: "t-1",
        leaseToken: TOKEN,
        result: { raw: true },
        impactPrior: {
          hazardType: "FL",
          countryLocationId: "loc-country",
          geographicScope: "country",
          horizonYears: 10,
          numberOfCases: 1,
          basis: [{ tier: "clear", eventId: "ev-old", scope: "country" }],
          methodVersion: "impact-prior@0.1.0",
        },
      },
      ctx(worker, prisma),
    );
    expect(done).toMatchObject({ status: "COMPLETED", outcome: "produced" });
    expect(prisma.impactPrior.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: "ev-1",
        taskId: "t-1",
        // The source is the Task's kind, never anything the Worker sends.
        sourceKind: CLEAR_KIND,
        hazardType: "FL",
        numberOfCases: 1,
      }),
    });
    // State is the column default (`proposed`): the Worker never sets it.
    expect(prisma.impactPrior.create.mock.calls[0][0].data).not.toHaveProperty("state");
  });

  it("without an impactPrior on an event.impact_prior.* Task records no_prior_found and writes no row", async () => {
    const prisma = seeded(leased());
    const done = await completeTask(null, { id: "t-1", leaseToken: TOKEN, result: { searched: 3, cases: 0 } }, ctx(worker, prisma));
    expect(done).toMatchObject({ status: "COMPLETED", outcome: "no_prior_found" });
    expect(prisma.impactPrior.create).not.toHaveBeenCalled();
  });

  it("leaves outcome null for a Task of another kind", async () => {
    const prisma = seeded(leased({ kind: "event.other" }));
    const done = await completeTask(null, { id: "t-1", leaseToken: TOKEN, result: {} }, ctx(worker, prisma));
    expect(done.outcome).toBeNull();
  });

  describe("usage", () => {
    const usage = { model: "anthropic/claude-sonnet-5-5", inputTokens: 1200, outputTokens: 300, costUsd: 0.0123 };

    it("is recorded on the Task as reported", async () => {
      const prisma = seeded(leased());
      const done = await completeTask(null, { id: "t-1", leaseToken: TOKEN, result: {}, usage }, ctx(worker, prisma));
      expect(done).toMatchObject(usage);
    });

    it("stays null when not reported", async () => {
      const prisma = seeded(leased());
      const done = await completeTask(null, { id: "t-1", leaseToken: TOKEN, result: {} }, ctx(worker, prisma));
      expect(done).toMatchObject({ model: null, inputTokens: null, outputTokens: null, costUsd: null });
    });

    it.each([
      ["an empty model", { ...usage, model: " " }],
      ["negative inputTokens", { ...usage, inputTokens: -1 }],
      ["fractional outputTokens", { ...usage, outputTokens: 1.5 }],
      ["a negative cost", { ...usage, costUsd: -0.01 }],
      ["an infinite cost", { ...usage, costUsd: Number.POSITIVE_INFINITY }],
    ])("rejects %s with BAD_USER_INPUT and writes nothing", async (_name, bad) => {
      const prisma = seeded(leased());
      const err = await errorOf(completeTask(null, { id: "t-1", leaseToken: TOKEN, result: {}, usage: bad }, ctx(worker, prisma)));
      expect(err.extensions.code).toBe("BAD_USER_INPUT");
      expect(prisma.task.store.get("t-1")!.status).toBe("LEASED");
    });
  });

  describe("ImpactPrior validation against the Event", () => {
    const proposal = () => ({
      hazardType: "FL",
      countryLocationId: "loc-country",
      geographicScope: "district",
      horizonYears: 10,
      numberOfCases: 2,
      basis: [{ tier: "clear", eventId: "ev-a", scope: "district" }, { tier: "web", sourceUrl: "https://x", scope: "country" }],
      methodVersion: "clear-impact-prior@0.1.0",
    });
    const complete = (prisma: ReturnType<typeof makePrisma>, impactPrior: Row) =>
      completeTask(null, { id: "t-1", leaseToken: TOKEN, result: {}, impactPrior: impactPrior as never }, ctx(worker, prisma));

    it("accepts a hazard among the Event's types and the Event's level-0 ancestor as country", async () => {
      const prisma = seeded(leased());
      const done = await complete(prisma, { ...proposal(), hazardType: "FF" });
      expect(done.outcome).toBe("produced");
    });

    it.each([
      ["a hazard not among the Event's types", { hazardType: "EQ" }, /hazardType/],
      ["a country that is not the Event's", { countryLocationId: "loc-state" }, /countryLocationId/],
      ["an unknown geographic scope", { geographicScope: "continent" }, /geographicScope/],
      ["zero cases (omit impactPrior for no_prior_found)", { numberOfCases: 0, basis: [] }, /numberOfCases/],
      ["a basis that does not list one entry per case", { numberOfCases: 1 }, /basis/],
      ["a zero horizon", { horizonYears: 0 }, /horizonYears/],
      ["an empty methodVersion", { methodVersion: "" }, /methodVersion/],
      ["validTo before validFrom", { validFrom: new Date("2026-02-01"), validTo: new Date("2026-01-01") }, /validTo/],
      ["validTo before validFrom as strings", { validFrom: "2026-02-01T00:00:00Z", validTo: "2026-01-01T00:00:00Z" }, /validTo must not precede/],
      ["an unparseable validFrom", { validFrom: new Date("not a date") }, /validFrom must be a valid date-time/],
      ["an unparseable validTo", { validFrom: new Date("2026-01-01"), validTo: new Date("2026-13-45") }, /validTo must be a valid date-time/],
    ])("rejects %s with BAD_USER_INPUT and writes nothing", async (_name, bad, message) => {
      const prisma = seeded(leased());
      const err = await errorOf(complete(prisma, { ...proposal(), ...bad }));
      expect(err.extensions.code).toBe("BAD_USER_INPUT");
      expect(err.message).toMatch(message);
      expect(prisma.task.store.get("t-1")!.status).toBe("LEASED");
      expect(prisma.impactPrior.create).not.toHaveBeenCalled();
    });

    it("rejects a proposal when the Event's country cannot be resolved", async () => {
      const prisma = seeded(leased());
      prisma.events.findUnique.mockResolvedValueOnce({
        id: "ev-1", types: ["FL"], locationId: null, originId: null, destinationId: null,
      });
      const err = await errorOf(complete(prisma, proposal()));
      expect(err.extensions.code).toBe("BAD_USER_INPUT");
      expect(err.message).toMatch(/country cannot be resolved/);
    });

    it("supersedes the newest existing ImpactPrior of the same source kind for the Event, never overwriting it", async () => {
      const prisma = seeded(leased());
      prisma.impactPrior.findFirst.mockResolvedValueOnce({ id: "ip-old" });
      await complete(prisma, proposal());
      expect(prisma.impactPrior.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: "ev-1", sourceKind: CLEAR_KIND }, orderBy: { createdAt: "desc" } }),
      );
      expect(prisma.impactPrior.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ supersedesId: "ip-old" }),
      });
      // Nothing touched the earlier row: there is no update delegate call to make.
      expect(prisma.impactPrior).not.toHaveProperty("update");
    });

    it("a .web proposal looks for its predecessor among .web proposals only — another source's is a sibling", async () => {
      const prisma = seeded(leased({ kind: WEB_KIND }));
      await complete(prisma, proposal());
      expect(prisma.impactPrior.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: "ev-1", sourceKind: WEB_KIND } }),
      );
      expect(prisma.impactPrior.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ sourceKind: WEB_KIND, supersedesId: null }),
      });
    });

    it("the bare event.impact_prior kind (claimable for one release) still takes a proposal, as its own source", async () => {
      const prisma = seeded(leased({ kind: IMPACT_PRIOR_KIND }));
      const done = await complete(prisma, proposal());
      expect(done.outcome).toBe("produced");
      expect(prisma.impactPrior.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ sourceKind: IMPACT_PRIOR_KIND }),
      });
    });
  });

  it("rejects an impactPrior on a Task of another kind with BAD_USER_INPUT, before any write", async () => {
    const prisma = seeded(leased({ kind: "event.other" }));
    const err = await errorOf(
      completeTask(
        null,
        {
          id: "t-1",
          leaseToken: TOKEN,
          result: {},
          impactPrior: {
            hazardType: "FL", countryLocationId: "loc-country", geographicScope: "country",
            horizonYears: 10, numberOfCases: 1, basis: [], methodVersion: "x",
          },
        },
        ctx(worker, prisma),
      ),
    );
    expect(err.extensions.code).toBe("BAD_USER_INPUT");
    expect(prisma.task.store.get("t-1")!.status).toBe("LEASED");
  });
});

describe("failTask", () => {
  it("returns the Task to PENDING with the error while attempts remain, releasing the lease", async () => {
    const prisma = seeded(leased({ attempts: 1, maxAttempts: 3 }));
    const row = await failTask(null, { id: "t-1", leaseToken: TOKEN, error: "model timed out" }, ctx(worker, prisma));
    expect(row).toMatchObject({
      status: "PENDING",
      lastError: "model timed out",
      leaseOwnerId: null,
      leaseExpiresAt: null,
      attempts: 1,
    });
  });

  it("marks the Task FAILED on the last attempt, keeping who last held it", async () => {
    const prisma = seeded(leased({ attempts: 3, maxAttempts: 3 }));
    const row = await failTask(null, { id: "t-1", leaseToken: TOKEN, error: "no model access" }, ctx(worker, prisma));
    expect(row).toMatchObject({
      status: "FAILED",
      lastError: "no model access",
      leaseOwnerId: "u-worker",
      leaseExpiresAt: null,
    });
  });

  it("caps a runaway error at 2000 characters", async () => {
    const prisma = seeded(leased({ attempts: 3, maxAttempts: 3 }));
    const row = await failTask(null, { id: "t-1", leaseToken: TOKEN, error: "x".repeat(5000) }, ctx(worker, prisma));
    expect((row.lastError as string).length).toBe(2000);
  });

  it("is BAD_USER_INPUT for an empty error, and writes nothing", async () => {
    const prisma = seeded(leased());
    const err = await errorOf(failTask(null, { id: "t-1", leaseToken: TOKEN, error: "   " }, ctx(worker, prisma)));
    expect(err.extensions.code).toBe("BAD_USER_INPUT");
    expect(prisma.task.store.get("t-1")!.status).toBe("LEASED");
  });

  it("is NOT_LEASE_OWNER for another worker", async () => {
    const prisma = seeded(leased());
    const err = await errorOf(failTask(null, { id: "t-1", leaseToken: TOKEN, error: "x" }, ctx(rivalWorker, prisma)));
    expect(err.extensions.subCode).toBe("NOT_LEASE_OWNER");
  });
});

describe("cancelTask", () => {
  it.each([
    ["the requester", analyst],
    ["a platform admin", admin],
  ])("%s cancels a PENDING Task at once", async (_name, user) => {
    const prisma = seeded(makeTask({ requesterId: "u-analyst" }));
    const row = await cancelTask(null, { id: "t-1" }, ctx(user, prisma));
    expect(row).toMatchObject({ status: "CANCELLED", cancelledById: user.id });
    expect(row.cancelRequestedAt).toBeInstanceOf(Date);
    await new Promise((r) => setImmediate(r));
    expect(prisma.activityLogs.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: user.id, action: "task.cancelled", resourceId: "t-1" }),
    });
  });

  it.each([
    ["another analyst", { id: "u-analyst-2", role: "analyst" }],
    ["a viewer", viewer],
    ["the worker holding it", worker],
  ])("is FORBIDDEN for %s", async (_name, user) => {
    const prisma = seeded(leased({ requesterId: "u-analyst" }));
    const err = await errorOf(cancelTask(null, { id: "t-1" }, ctx(user, prisma)));
    expect(err.extensions.code).toBe("FORBIDDEN");
    expect(prisma.task.store.get("t-1")!.cancelRequestedAt).toBeNull();
  });

  it("is UNAUTHENTICATED without a user and NOT_FOUND for an unknown id", async () => {
    expect((await errorOf(cancelTask(null, { id: "t-1" }, ctx(null)))).extensions.code).toBe("UNAUTHENTICATED");
    expect((await errorOf(cancelTask(null, { id: "t-nope" }, ctx(admin)))).extensions.code).toBe("NOT_FOUND");
  });

  it("flags a LEASED Task instead of cancelling it outright, and is idempotent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:10:00Z")); // lease (10:15) still live
    const prisma = seeded(leased({ requesterId: "u-analyst" }));
    const row = await cancelTask(null, { id: "t-1" }, ctx(analyst, prisma));
    expect(row).toMatchObject({ status: "LEASED", leaseOwnerId: "u-worker", cancelledById: "u-analyst" });
    expect(row.cancelRequestedAt).toBeInstanceOf(Date);
    const again = await cancelTask(null, { id: "t-1" }, ctx(analyst, prisma));
    expect(again.cancelRequestedAt).toEqual(row.cancelRequestedAt);
    expect(prisma.activityLogs.create).toHaveBeenCalledTimes(1);
  });

  it("cancels a LEASED Task whose lease has lapsed at once — its Worker is not coming back", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T11:00:00Z"));
    const prisma = seeded(leased({ requesterId: "u-analyst", leaseExpiresAt: new Date("2026-10-06T10:15:00Z") }));
    const row = await cancelTask(null, { id: "t-1" }, ctx(analyst, prisma));
    expect(row).toMatchObject({ status: "CANCELLED", leaseExpiresAt: null, cancelledById: "u-analyst" });
    expect(row.cancelRequestedAt).toEqual(new Date("2026-10-06T11:00:00Z"));
  });

  it("finishes an already-flagged LEASED Task once its lease has lapsed, keeping the original request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T11:00:00Z"));
    const flaggedAt = new Date("2026-10-06T10:05:00Z");
    const prisma = seeded(
      leased({ requesterId: "u-analyst", leaseExpiresAt: new Date("2026-10-06T10:15:00Z"), cancelRequestedAt: flaggedAt, cancelledById: "u-admin" }),
    );
    const row = await cancelTask(null, { id: "t-1" }, ctx(analyst, prisma));
    expect(row).toMatchObject({ status: "CANCELLED", cancelRequestedAt: flaggedAt, cancelledById: "u-admin" });
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"])("is CONFLICT for a %s Task", async (status) => {
    const prisma = seeded(makeTask({ status, requesterId: "u-analyst" }));
    const err = await errorOf(cancelTask(null, { id: "t-1" }, ctx(analyst, prisma)));
    expect(err.extensions.code).toBe("CONFLICT");
  });

  describe("the Worker finishes a requested cancel", () => {
    const flagged = () => leased({ cancelRequestedAt: new Date("2026-10-06T10:05:00Z"), cancelledById: "u-analyst" });

    it("at its next heartbeat: the Task becomes CANCELLED and the lease is released", async () => {
      const prisma = seeded(flagged());
      const row = await heartbeatTask(null, { id: "t-1", leaseToken: TOKEN }, ctx(worker, prisma));
      expect(row).toMatchObject({ status: "CANCELLED", leaseExpiresAt: null, cancelledById: "u-analyst" });
    });

    it("at completion: the result and any ImpactPrior are discarded", async () => {
      const prisma = seeded(flagged());
      const row = await completeTask(
        null,
        {
          id: "t-1",
          leaseToken: TOKEN,
          result: { late: true },
          impactPrior: {
            hazardType: "FL", countryLocationId: "loc-country", geographicScope: "country",
            horizonYears: 10, numberOfCases: 1, basis: [{ tier: "web", scope: "country" }], methodVersion: "x",
          },
        },
        ctx(worker, prisma),
      );
      expect(row).toMatchObject({ status: "CANCELLED", result: null, outcome: null });
      expect(prisma.impactPrior.create).not.toHaveBeenCalled();
    });

    it("at failure: CANCELLED rather than PENDING, so it is never retried", async () => {
      const prisma = seeded(flagged());
      const row = await failTask(null, { id: "t-1", leaseToken: TOKEN, error: "gave up" }, ctx(worker, prisma));
      expect(row.status).toBe("CANCELLED");
    });

    it("at completion with a malformed proposal: the cancel wins over BAD_USER_INPUT", async () => {
      const prisma = seeded(flagged());
      const row = await completeTask(
        null,
        {
          id: "t-1",
          leaseToken: TOKEN,
          result: {},
          impactPrior: {
            hazardType: "FL", countryLocationId: "loc-country", geographicScope: "country",
            horizonYears: 10, numberOfCases: 1, basis: [{ tier: "web", scope: "country" }], methodVersion: "x",
            validFrom: new Date("not a date"),
          } as never,
        },
        ctx(worker, prisma),
      );
      expect(row).toMatchObject({ status: "CANCELLED", result: null, outcome: null });
      expect(prisma.impactPrior.create).not.toHaveBeenCalled();
    });

    it("at failure with an empty error: the cancel wins over BAD_USER_INPUT", async () => {
      const prisma = seeded(flagged());
      const row = await failTask(null, { id: "t-1", leaseToken: TOKEN, error: "   " }, ctx(worker, prisma));
      expect(row).toMatchObject({ status: "CANCELLED", lastError: null });
    });

    it("a cancel landing between the pre-check and the write still wins", async () => {
      const prisma = seeded(leased());
      prisma.task.findUnique.mockImplementationOnce(async () => leased());
      prisma.task.store.set("t-1", flagged());
      const row = await completeTask(null, { id: "t-1", leaseToken: TOKEN, result: { late: true } }, ctx(worker, prisma));
      expect(row).toMatchObject({ status: "CANCELLED", result: null });
    });
  });
});

describe("completeTask with cases (V4)", () => {
  const webLeased = (overrides: Row = {}) => leased({ kind: WEB_KIND, ...overrides });
  const aCase = (overrides: Row = {}) => ({
    sourceUrl: "https://example.test/flood-2021",
    quote: "Floods displaced 4,000 people in Testville.",
    occurredAt: new Date("2021-08-01T00:00:00Z"),
    locationLabel: "Testville",
    hazardType: "FL",
    geographicScope: "district",
    figures: [{ metric: "people_displaced_new", value: 4000, lowerBound: 3500, upperBound: 4500 }],
    ...overrides,
  });
  const complete = (prisma: ReturnType<typeof makePrisma>, args: Row) =>
    completeTask(
      null,
      { id: "t-1", leaseToken: TOKEN, result: { raw: true }, methodVersion: "clear-impact-prior-web@0.4.0", ...args } as never,
      ctx(worker, prisma),
    );

  it("writes one proposed CaseProposal per case, no ImpactPrior, outcome produced", async () => {
    const prisma = seeded(webLeased());
    const done = await complete(prisma, {
      cases: [aCase(), aCase({ sourceUrl: "https://example.test/flood-2019", matchedEventId: "ev-old", locationId: "loc-district" })],
    });
    expect(done).toMatchObject({ status: "COMPLETED", outcome: "produced" });
    expect(prisma.impactPrior.create).not.toHaveBeenCalled();
    const rows = [...prisma.caseProposal.store.values()];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      eventId: "ev-1",
      taskId: "t-1",
      state: "proposed",
      sourceUrl: "https://example.test/flood-2021",
      hazardType: "FL",
      methodVersion: "clear-impact-prior-web@0.4.0",
      figures: [{ metric: "people_displaced_new", value: 4000, lowerBound: 3500, upperBound: 4500 }],
      matchedEventId: null,
    });
    expect(rows[1]).toMatchObject({ matchedEventId: "ev-old", locationId: "loc-district" });
    // State is the column default: the Worker never sets it.
    expect(prisma.caseProposal.createMany.mock.calls[0][0].data[0]).not.toHaveProperty("state");
    expect(prisma.caseProposal.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it("an empty list records no_prior_found", async () => {
    const prisma = seeded(webLeased());
    const done = await complete(prisma, { cases: [] });
    expect(done).toMatchObject({ status: "COMPLETED", outcome: "no_prior_found" });
    expect(prisma.caseProposal.createMany).not.toHaveBeenCalled();
  });

  it("skips a URL already proposed for the Event (any state) instead of failing", async () => {
    const prisma = seeded(webLeased());
    prisma.caseProposal.store.set("ev-1|https://example.test/flood-2021", { state: "rejected" });
    const done = await complete(prisma, { cases: [aCase(), aCase({ sourceUrl: "https://example.test/new" })] });
    expect(done.status).toBe("COMPLETED");
    expect(prisma.caseProposal.store.get("ev-1|https://example.test/flood-2021")).toEqual({ state: "rejected" });
    expect(prisma.caseProposal.store.has("ev-1|https://example.test/new")).toBe(true);
  });

  it.each([
    ["a non-web kind", { kind: CLEAR_KIND }, { cases: [] }, 'Cases can only complete an "event.impact_prior.web" Task'],
    ["both cases and an impactPrior", {}, {
      cases: [],
      impactPrior: { hazardType: "FL", countryLocationId: "loc-country", geographicScope: "country", horizonYears: 10, numberOfCases: 1, basis: [{}], methodVersion: "x" },
    }, "either cases or an impactPrior"],
    ["cases without a methodVersion", {}, { cases: [aCase()], methodVersion: " " }, "methodVersion is required with cases"],
  ])("rejects %s", async (_name, task, args, message) => {
    const prisma = seeded(webLeased(task));
    const err = await errorOf(complete(prisma, args));
    expect(err.extensions.code).toBe("BAD_USER_INPUT");
    expect(err.message).toContain(message);
    expect(prisma.task.store.get("t-1")!.status).toBe("LEASED");
  });

  it.each([
    ["a hazard the Event does not manifest", aCase({ hazardType: "EQ" }), 'hazardType "EQ" is not one of the Event\'s types'],
    ["a location outside the Event's country", aCase({ locationId: "loc-abroad" }), "not a location in the Event's country"],
    ["a matched Event that does not exist", aCase({ matchedEventId: "ev-nope" }), "is not an Event"],
    ["the Event being enriched as its own match", aCase({ matchedEventId: "ev-1" }), "a case is a past incident"],
    ["a matched Event abroad", aCase({ matchedEventId: "ev-abroad" }), "outside the Event's country"],
    ["a case older than the horizon", aCase({ occurredAt: new Date("2001-01-01T00:00:00Z") }), "10-year horizon"],
    ["a figure off the ontology's metrics", aCase({ figures: [{ metric: "deaths", value: 3 }] }), "metric must be one of"],
  ])("rejects %s before any write", async (_name, c, message) => {
    const prisma = seeded(webLeased());
    const err = await errorOf(complete(prisma, { cases: [c] }));
    expect(err.extensions.code).toBe("BAD_USER_INPUT");
    expect(err.message).toContain(message);
    expect(prisma.caseProposal.createMany).not.toHaveBeenCalled();
    expect(prisma.task.store.get("t-1")!.status).toBe("LEASED");
  });

  it("turns the web cases of a whole-prior proposal into CaseProposals too (pre-V4 Workers)", async () => {
    const prisma = seeded(webLeased());
    await complete(prisma, {
      methodVersion: undefined,
      impactPrior: {
        hazardType: "FL",
        countryLocationId: "loc-country",
        geographicScope: "country",
        horizonYears: 10,
        numberOfCases: 3,
        basis: [
          { tier: "web", sourceUrl: "https://example.test/a", quote: "a", occurredAt: "2026-01-11", locationLabel: "Yabus", scope: "district" },
          { tier: "web", sourceUrl: "https://example.test/b", occurredAt: "not a date" },
          { tier: "clear", eventId: "ev-old" },
        ],
        methodVersion: "clear-impact-prior-web@0.3.0",
      },
    });
    expect(prisma.impactPrior.create).toHaveBeenCalled();
    const rows = [...prisma.caseProposal.store.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceUrl: "https://example.test/a",
      quote: "a",
      locationLabel: "Yabus",
      geographicScope: "district",
      hazardType: "FL",
      methodVersion: "clear-impact-prior-web@0.3.0",
    });
  });
});

describe("case reads (V4)", () => {
  const row = (overrides: Row) => ({
    id: "cp-1", eventId: "ev-1", taskId: "t-1", state: "proposed", sourceUrl: "https://example.test/a",
    task: { requesterId: "u-analyst" }, ...overrides,
  });

  it("caseProposals lists proposed cases newest first for deciders, defaulting state and paging", async () => {
    const prisma = makePrisma();
    await caseProposalsQuery(null, {}, ctx(analyst, prisma));
    expect(prisma.caseProposal.findMany).toHaveBeenCalledWith({
      where: { state: "proposed" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      skip: 0,
    });
    await caseProposalsQuery(null, { state: "rejected", limit: 900, offset: -1 }, ctx(admin, prisma));
    expect(prisma.caseProposal.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { state: "rejected" }, take: 200, skip: 0 }),
    );
  });

  it.each([["a viewer", viewer], ["a worker", worker]])("caseProposals is FORBIDDEN for %s", async (_n, user) => {
    const prisma = makePrisma();
    expect((await errorOf(caseProposalsQuery(null, {}, ctx(user, prisma)))).extensions.code).toBe("FORBIDDEN");
    expect(prisma.caseProposal.findMany).not.toHaveBeenCalled();
  });

  it("eventCaseProposals follows the ImpactPrior visibility rule", async () => {
    const prisma = makePrisma();
    const rows = [
      row({ id: "cp-accepted", state: "accepted", task: { requesterId: "someone" } }),
      row({ id: "cp-mine", state: "proposed" }),
      row({ id: "cp-theirs", state: "proposed", task: { requesterId: "someone" } }),
      row({ id: "cp-rejected", state: "rejected" }),
    ];
    prisma.caseProposal.findMany.mockResolvedValue(rows);
    const ids = async (user: User) => (await eventCaseProposals(null, { eventId: "ev-1" }, ctx(user, prisma))).map((r) => r.id);
    expect(await ids(admin)).toEqual(["cp-accepted", "cp-mine", "cp-theirs", "cp-rejected"]);
    expect(await ids({ id: "u-analyst", role: "viewer" })).toEqual(["cp-accepted", "cp-mine"]);
    expect(await ids(viewer)).toEqual(["cp-accepted"]);
    // The requester link is resolver plumbing, not part of the row returned.
    expect((await eventCaseProposals(null, { eventId: "ev-1" }, ctx(admin, prisma)))[0]).not.toHaveProperty("task");
  });

  it("rejectedCaseUrls gives a Worker the Event's rejected URLs only", async () => {
    const prisma = makePrisma();
    prisma.caseProposal.findMany.mockResolvedValue([{ sourceUrl: "https://example.test/no" }]);
    expect(await rejectedCaseUrls(null, { eventId: "ev-1" }, ctx(worker, prisma))).toEqual(["https://example.test/no"]);
    expect(prisma.caseProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "ev-1", state: "rejected" }, select: { sourceUrl: true } }),
    );
    expect((await errorOf(rejectedCaseUrls(null, { eventId: "ev-1" }, ctx(viewer, prisma)))).extensions.code).toBe("FORBIDDEN");
  });
});

describe("decideImpactPrior", () => {
  const proposed = (overrides: Row = {}): Row => ({
    id: "ip-1", eventId: "ev-1", taskId: "t-1", state: "proposed", hazardType: "FL",
    decidedById: null, decidedAt: null, decisionRationale: null, ...overrides,
  });
  const seededPrior = (row: Row = proposed()) => {
    const prisma = makePrisma();
    prisma.impactPrior.store.set(row.id as string, row);
    return prisma;
  };

  it.each([
    ["admin accepts", admin, "accepted"],
    ["analyst rejects", analyst, "rejected"],
  ])("%s a proposed ImpactPrior, recording who, when and why", async (_name, user, decision) => {
    vi.useFakeTimers({ toFake: ["Date"] }); // keep setImmediate real for the log-settle wait below
    vi.setSystemTime(new Date("2026-10-07T09:00:00Z"));
    const prisma = seededPrior();
    const row = await decideImpactPrior(null, { id: "ip-1", decision: decision as never, rationale: "  Cases check out. " }, ctx(user, prisma));
    expect(row).toMatchObject({
      state: decision,
      decidedById: user.id,
      decidedAt: new Date("2026-10-07T09:00:00Z"),
      decisionRationale: "Cases check out.",
    });
    await new Promise((r) => setImmediate(r));
    expect(prisma.activityLogs.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: user.id, action: "impact_prior.decided", resourceType: "impact_prior", resourceId: "ip-1",
        metadata: expect.objectContaining({ decision, eventId: "ev-1" }),
      }),
    });
  });

  it.each([
    ["a viewer", viewer],
    ["a team coordinator", coordinator],
    ["a worker", worker],
    ["pipeline", pipeline],
  ])("is FORBIDDEN for %s — only platform admins and analysts decide", async (_name, user) => {
    const prisma = seededPrior();
    const err = await errorOf(decideImpactPrior(null, { id: "ip-1", decision: "accepted", rationale: "x" }, ctx(user, prisma)));
    expect(err.extensions.code).toBe("FORBIDDEN");
    expect(prisma.impactPrior.store.get("ip-1")!.state).toBe("proposed");
  });

  it("is NOT_FOUND for an unknown id and BAD_USER_INPUT for an empty rationale", async () => {
    expect((await errorOf(decideImpactPrior(null, { id: "ip-nope", decision: "accepted", rationale: "x" }, ctx(admin)))).extensions.code).toBe("NOT_FOUND");
    const prisma = seededPrior();
    const err = await errorOf(decideImpactPrior(null, { id: "ip-1", decision: "accepted", rationale: "   " }, ctx(admin, prisma)));
    expect(err.extensions.code).toBe("BAD_USER_INPUT");
    expect(prisma.impactPrior.store.get("ip-1")!.state).toBe("proposed");
  });

  it.each(["accepted", "rejected"])("is CONFLICT once already %s — a decision is recorded once", async (state) => {
    const prisma = seededPrior(proposed({ state, decidedById: "u-admin" }));
    const err = await errorOf(decideImpactPrior(null, { id: "ip-1", decision: "rejected", rationale: "x" }, ctx(analyst, prisma)));
    expect(err.extensions.code).toBe("CONFLICT");
    expect(prisma.impactPrior.store.get("ip-1")).toMatchObject({ state, decidedById: "u-admin" });
  });

  it("a decision landing between the read and the write is not overwritten", async () => {
    const prisma = seededPrior();
    prisma.impactPrior.findUnique.mockImplementationOnce(async () => proposed());
    prisma.impactPrior.store.set("ip-1", proposed({ state: "accepted", decidedById: "u-other" }));
    const err = await errorOf(decideImpactPrior(null, { id: "ip-1", decision: "rejected", rationale: "x" }, ctx(analyst, prisma)));
    expect(err.extensions.code).toBe("CONFLICT");
    expect(prisma.impactPrior.store.get("ip-1")!.decidedById).toBe("u-other");
  });
});

describe("impactPriors — the Inbox query", () => {
  it("lists proposed rows newest first for deciders, defaulting state and paging", async () => {
    const prisma = makePrisma();
    prisma.impactPrior.findMany.mockResolvedValue([{ id: "ip-1", state: "proposed" }]);
    const rows = await impactPriorsQuery(null, {}, ctx(analyst, prisma));
    expect(rows.map((r) => r.id)).toEqual(["ip-1"]);
    // Web proposals (and the bare kind) are decided case by case (V4).
    const notCaseReviewed = { notIn: ["event.impact_prior", "event.impact_prior.web"] };
    expect(prisma.impactPrior.findMany).toHaveBeenCalledWith({
      where: { state: "proposed", sourceKind: notCaseReviewed },
      orderBy: { createdAt: "desc" },
      take: 50,
      skip: 0,
    });
    await impactPriorsQuery(null, { state: "rejected", limit: 500, offset: -3 }, ctx(admin, prisma));
    expect(prisma.impactPrior.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { state: "rejected", sourceKind: notCaseReviewed }, take: 200, skip: 0 }),
    );
  });

  it.each([
    ["a viewer", viewer],
    ["a team coordinator", coordinator],
    ["a worker", worker],
  ])("is FORBIDDEN for %s — the Inbox lists only what the caller may decide", async (_name, user) => {
    const prisma = makePrisma();
    const err = await errorOf(impactPriorsQuery(null, {}, ctx(user, prisma)));
    expect(err.extensions.code).toBe("FORBIDDEN");
    expect(prisma.impactPrior.findMany).not.toHaveBeenCalled();
  });
});

describe("myTasks — the requester's own requests", () => {
  it("lists only the caller's Tasks, newest first, with lastError present, defaulting the page", async () => {
    const prisma = makePrisma();
    const mine = makeTask({ id: "t-mine", requesterId: "u-coord", status: "FAILED", lastError: "boom" });
    prisma.task.findMany.mockResolvedValue([mine]);
    const rows = await myTasks(null, {}, ctx(coordinator, prisma));
    expect(rows).toEqual([mine]);
    expect(rows[0].lastError).toBe("boom");
    expect(prisma.task.findMany).toHaveBeenCalledWith({
      where: { requesterId: "u-coord" },
      // id breaks createdAt ties so offset pages are stable.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      skip: 0,
    });
  });

  it("narrows by status and clamps the page to [1, 200] / offset ≥ 0", async () => {
    const prisma = makePrisma();
    await myTasks(null, { status: "PENDING", limit: 500, offset: -3 }, ctx(analyst, prisma));
    expect(prisma.task.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { requesterId: "u-analyst", status: "PENDING" }, take: 200, skip: 0 }),
    );
    await myTasks(null, { limit: 0 }, ctx(analyst, prisma));
    expect(prisma.task.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 1 }));
  });

  it("is always the caller's scope — an admin asking for another user's Tasks gets their own", async () => {
    const prisma = makePrisma();
    await myTasks(null, {}, ctx(admin, prisma));
    expect(prisma.task.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { requesterId: "u-admin" } }));
  });

  it.each([
    ["a worker — it requests nothing", worker, "FORBIDDEN"],
    ["a pending user", { id: "u-p", role: "pending" }, "FORBIDDEN"],
  ])("refuses %s", async (_name, user, code) => {
    const prisma = makePrisma();
    const err = await errorOf(myTasks(null, {}, ctx(user, prisma)));
    expect(err.extensions.code).toBe(code);
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });

  it("is UNAUTHENTICATED without a user", async () => {
    const err = await errorOf(myTasks(null, {}, ctx(null)));
    expect(err.extensions.code).toBe("UNAUTHENTICATED");
  });
});

describe("reads", () => {
  it("task / eventTasks need a content reader — a pending user is FORBIDDEN, a worker may read", async () => {
    const prisma = seeded(makeTask());
    const err = await errorOf(taskQuery(null, { id: "t-1" }, ctx({ id: "u-p", role: "pending" }, prisma)));
    expect(err.extensions.code).toBe("FORBIDDEN");
    expect(await taskQuery(null, { id: "t-1" }, ctx(worker, prisma))).toMatchObject({ id: "t-1" });
  });

  it("redacts lastError for everyone but the requester and platform admins", async () => {
    const prisma = makePrisma();
    const failed = makeTask({ status: "FAILED", lastError: "boom", requesterId: "u-analyst" });
    prisma.task.findMany.mockResolvedValue([failed]);
    const see = async (user: User) =>
      (await eventTasks(null, { eventId: "ev-1" }, ctx(user, prisma)))[0].lastError;
    expect(await see(analyst)).toBe("boom");
    expect(await see(admin)).toBe("boom");
    expect(await see(viewer)).toBeNull();
    expect(await see(worker)).toBeNull();
  });

  it("ImpactPrior.task redacts lastError like the Task reads do", async () => {
    const prisma = seeded(makeTask({ status: "FAILED", lastError: "boom", requesterId: "u-analyst" }));
    const prior = { id: "ip-1", taskId: "t-1", eventId: "ev-1", supersedesId: null } as never;
    expect((await taskResolvers.ImpactPrior.task(prior, null, ctx(viewer, prisma))).lastError).toBeNull();
    expect((await taskResolvers.ImpactPrior.task(prior, null, ctx(analyst, prisma))).lastError).toBe("boom");
    expect((await taskResolvers.ImpactPrior.task(prior, null, ctx(admin, prisma))).lastError).toBe("boom");
  });

  it("ImpactPrior.supersedes applies the same visibility rule as eventImpactPriors", async () => {
    const prisma = makePrisma();
    const predecessor = { id: "ip-old", state: "proposed", eventId: "ev-1", task: { requesterId: "u-coord" } };
    (prisma.impactPrior as unknown as { findUnique: unknown }).findUnique = vi.fn(async () => predecessor);
    const newer = { id: "ip-new", supersedesId: "ip-old", eventId: "ev-1" } as never;
    expect(await taskResolvers.ImpactPrior.supersedes(newer, null, ctx(viewer, prisma))).toBeNull();
    expect(await taskResolvers.ImpactPrior.supersedes(newer, null, ctx(coordinator, prisma))).toMatchObject({ id: "ip-old" });
    expect(await taskResolvers.ImpactPrior.supersedes(newer, null, ctx(admin, prisma))).toMatchObject({ id: "ip-old" });
    expect(await taskResolvers.ImpactPrior.supersedes(newer, null, ctx(admin, prisma))).not.toHaveProperty("task");
    expect(await taskResolvers.ImpactPrior.supersedes({ id: "ip-first", supersedesId: null } as never, null, ctx(admin, prisma))).toBeNull();
  });

  it("eventImpactPriors: accepted follows the Event, proposed is for the requester and deciders, rejected for deciders only", async () => {
    const prisma = makePrisma();
    const rows = [
      { id: "ip-p", state: "proposed", eventId: "ev-1", task: { requesterId: "u-coord" } },
      { id: "ip-a", state: "accepted", eventId: "ev-1", task: { requesterId: "u-coord" } },
      { id: "ip-r", state: "rejected", eventId: "ev-1", task: { requesterId: "u-coord" } },
    ];
    prisma.impactPrior.findMany.mockResolvedValue(rows);
    const ids = async (user: User) =>
      (await eventImpactPriors(null, { eventId: "ev-1" }, ctx(user, prisma))).map((r) => r.id);
    expect(await ids(admin)).toEqual(["ip-p", "ip-a", "ip-r"]);
    expect(await ids(analyst)).toEqual(["ip-p", "ip-a", "ip-r"]);
    // The requester (a coordinator) sees their own proposal and the accepted one, not the rejected history.
    expect(await ids(coordinator)).toEqual(["ip-p", "ip-a"]);
    expect(await ids(viewer)).toEqual(["ip-a"]);
    expect(await ids(worker)).toEqual(["ip-a"]);
    // The join used for the visibility rule never leaks into the result.
    const [first] = await eventImpactPriors(null, { eventId: "ev-1" }, ctx(admin, prisma));
    expect(first).not.toHaveProperty("task");
  });
});
