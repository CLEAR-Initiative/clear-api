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

import { taskResolvers, IMPACT_PRIOR_KIND } from "../../src/resolvers/task.resolver.js";
import type { Context } from "../../src/context.js";

type Row = Record<string, unknown>;

function makeTask(overrides: Row = {}): Row {
  return {
    id: "t-1",
    kind: IMPACT_PRIOR_KIND,
    subjectType: "event",
    subjectId: "ev-1",
    payload: { horizonYears: 10 },
    status: "PENDING",
    origin: "user",
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

/** A `where` of equality conditions (what the resolver's conditional
 *  writes use) matched against a row. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

function makePrisma(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, Row>();
  const task = {
    store,
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = store.get(where.id);
      if (!row) throw new Error("not found");
      return row;
    }),
    findFirst: vi.fn(async (): Promise<Row | null> => null),
    findMany: vi.fn(async (): Promise<Row[]> => []),
    count: vi.fn(async () => 0),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = makeTask({ ...data });
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
  const impactPrior = {
    findFirst: vi.fn(async (): Promise<Row | null> => null),
    findMany: vi.fn(async (): Promise<Row[]> => []),
    create: vi.fn(async ({ data }: { data: Row }) => ({ id: "ip-1", state: "proposed", ...data })),
  };
  const events = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === "ev-1"
        ? { id: "ev-1", types: ["FL", "FF"], locationId: "loc-district", originId: null, destinationId: null }
        : null,
    ),
  };
  // loc-district (level 2) → loc-state (1) → loc-country (0).
  const LOCATIONS: Record<string, Row> = {
    "loc-district": { id: "loc-district", level: 2, ancestorIds: ["loc-state", "loc-country"] },
    "loc-state": { id: "loc-state", level: 1, ancestorIds: ["loc-country"] },
    "loc-country": { id: "loc-country", level: 0, ancestorIds: [] },
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
    task, impactPrior, events, locations, activityLogs, teamMembers,
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
    task: typeof task; impactPrior: typeof impactPrior; events: typeof events;
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

const { requestEventEnrichment, claimTasks, heartbeatTask, completeTask, failTask, cancelTask } = taskResolvers.Mutation;
const { leaseToken: leaseTokenField } = taskResolvers.Task;
const { task: taskQuery, eventTasks, eventImpactPriors } = taskResolvers.Query;

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
      expect(result).toMatchObject({ kind: IMPACT_PRIOR_KIND, subjectType: "event", subjectId: "ev-1" });
      expect(prisma.task.create).toHaveBeenCalledOnce();
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

  it("records the CALLER as requester and the view-scope team", async () => {
    const prisma = makePrisma();
    await requestEventEnrichment(null, { eventId: "ev-1", teamId: "team-a" }, ctx(coordinator, prisma));
    expect(prisma.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requesterId: "u-coord", teamId: "team-a" }),
    });
  });

  it("stores the horizon in the payload, defaulting to 10 years", async () => {
    const prisma = makePrisma();
    await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
    expect(prisma.task.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ payload: { horizonYears: 10 } }),
    });
    await requestEventEnrichment(null, { eventId: "ev-1", horizonYears: 5 }, ctx(analyst, prisma));
    expect(prisma.task.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ payload: { horizonYears: 5 } }),
    });
  });

  describe("dedupe — one open Task per Event and kind", () => {
    it.each(["PENDING", "LEASED"])("returns the existing %s Task unchanged instead of creating a second", async (status) => {
      const prisma = makePrisma();
      const open = makeTask({ id: "t-open", status, requesterId: "u-someone-else", payload: { horizonYears: 3 } });
      prisma.task.findFirst.mockResolvedValue(open);
      const result = await requestEventEnrichment(null, { eventId: "ev-1", horizonYears: 10 }, ctx(analyst, prisma));
      expect(result).toBe(open);
      expect(prisma.task.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          kind: IMPACT_PRIOR_KIND, subjectType: "event", subjectId: "ev-1",
          status: { in: ["PENDING", "LEASED"] },
        }),
      });
      expect(prisma.task.create).not.toHaveBeenCalled();
      expect(prisma.activityLogs.create).not.toHaveBeenCalled();
    });

    it("returns the winner when the partial unique index rejects a concurrent create", async () => {
      const prisma = makePrisma();
      const winner = makeTask({ id: "t-winner" });
      prisma.task.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      prisma.task.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      const result = await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      expect(result).toBe(winner);
    });

    it("rethrows any other create failure", async () => {
      const prisma = makePrisma();
      prisma.task.create.mockRejectedValueOnce(new Error("connection lost"));
      await expect(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma))).rejects.toThrow("connection lost");
    });
  });

  describe("per-requester daily cap (TASK_REQUEST_DAILY_CAP, default 20)", () => {
    it("counts the caller's Tasks since UTC midnight", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-06T15:30:00Z"));
      const prisma = makePrisma();
      await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      expect(prisma.task.count).toHaveBeenCalledWith({
        where: { requesterId: "u-analyst", createdAt: { gte: new Date("2026-10-06T00:00:00Z") } },
      });
    });

    it("allows the 20th request and rejects the 21st with FORBIDDEN / DAILY_CAP naming the cap", async () => {
      const prisma = makePrisma();
      prisma.task.count.mockResolvedValueOnce(19);
      await expect(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma))).resolves.toBeDefined();
      prisma.task.count.mockResolvedValueOnce(20);
      const err = await errorOf(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma)));
      expect(err.extensions).toMatchObject({ code: "FORBIDDEN", subCode: "DAILY_CAP" });
      expect(err.message).toContain("20");
      expect(prisma.task.create).toHaveBeenCalledTimes(1);
    });

    it("applies to admins too, and to API-key callers", async () => {
      const prisma = makePrisma();
      prisma.task.count.mockResolvedValue(20);
      const a = await errorOf(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(admin, prisma)));
      expect(a.extensions.subCode).toBe("DAILY_CAP");
      const b = await errorOf(requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma, "api-key")));
      expect(b.extensions.subCode).toBe("DAILY_CAP");
    });

    it("does not apply when the request dedupes onto an open Task", async () => {
      const prisma = makePrisma();
      prisma.task.findFirst.mockResolvedValue(makeTask({ id: "t-open" }));
      prisma.task.count.mockResolvedValue(20);
      const result = await requestEventEnrichment(null, { eventId: "ev-1" }, ctx(analyst, prisma));
      expect(result.id).toBe("t-open");
      expect(prisma.task.count).not.toHaveBeenCalled();
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

  it("logs task.requested against the caller with the new Task's id", async () => {
    const prisma = makePrisma();
    await requestEventEnrichment(null, { eventId: "ev-1", teamId: "team-a" }, ctx(coordinator, prisma));
    // logActivity is fire-and-forget; let it settle.
    await new Promise((r) => setImmediate(r));
    expect(prisma.activityLogs.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "u-coord",
        action: "task.requested",
        resourceType: "task",
        resourceId: "t-1",
        metadata: expect.objectContaining({ kind: IMPACT_PRIOR_KIND, subjectId: "ev-1", teamId: "team-a" }),
      }),
    });
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
    prisma.$queryRaw.mockResolvedValueOnce([{ id: "t-2" }, { id: "t-1" }]);
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
        hazardType: "FL",
        numberOfCases: 1,
      }),
    });
    // State is the column default (`proposed`): the Worker never sets it.
    expect(prisma.impactPrior.create.mock.calls[0][0].data).not.toHaveProperty("state");
  });

  it("without an impactPrior on an event.impact_prior Task records no_prior_found and writes no row", async () => {
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

    it("supersedes the newest existing ImpactPrior for the Event, never overwriting it", async () => {
      const prisma = seeded(leased());
      prisma.impactPrior.findFirst.mockResolvedValueOnce({ id: "ip-old" });
      await complete(prisma, proposal());
      expect(prisma.impactPrior.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: "ev-1" }, orderBy: { createdAt: "desc" } }),
      );
      expect(prisma.impactPrior.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ supersedesId: "ip-old" }),
      });
      // Nothing touched the earlier row: there is no update delegate call to make.
      expect(prisma.impactPrior).not.toHaveProperty("update");
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
    const prisma = seeded(leased({ requesterId: "u-analyst" }));
    const row = await cancelTask(null, { id: "t-1" }, ctx(analyst, prisma));
    expect(row).toMatchObject({ status: "LEASED", leaseOwnerId: "u-worker", cancelledById: "u-analyst" });
    expect(row.cancelRequestedAt).toBeInstanceOf(Date);
    const again = await cancelTask(null, { id: "t-1" }, ctx(analyst, prisma));
    expect(again.cancelRequestedAt).toEqual(row.cancelRequestedAt);
    expect(prisma.activityLogs.create).toHaveBeenCalledTimes(1);
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

    it("a cancel landing between the pre-check and the write still wins", async () => {
      const prisma = seeded(leased());
      prisma.task.findUnique.mockImplementationOnce(async () => leased());
      prisma.task.store.set("t-1", flagged());
      const row = await completeTask(null, { id: "t-1", leaseToken: TOKEN, result: { late: true } }, ctx(worker, prisma));
      expect(row).toMatchObject({ status: "CANCELLED", result: null });
    });
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

  it("eventImpactPriors shows every state to admins, analysts and the requester; accepted only to others", async () => {
    const prisma = makePrisma();
    const rows = [
      { id: "ip-p", state: "proposed", eventId: "ev-1", task: { requesterId: "u-coord" } },
      { id: "ip-a", state: "accepted", eventId: "ev-1", task: { requesterId: "u-coord" } },
      { id: "ip-r", state: "rejected", eventId: "ev-1", task: { requesterId: "u-other" } },
    ];
    prisma.impactPrior.findMany.mockResolvedValue(rows);
    const ids = async (user: User) =>
      (await eventImpactPriors(null, { eventId: "ev-1" }, ctx(user, prisma))).map((r) => r.id);
    expect(await ids(admin)).toEqual(["ip-p", "ip-a", "ip-r"]);
    expect(await ids(analyst)).toEqual(["ip-p", "ip-a", "ip-r"]);
    expect(await ids(coordinator)).toEqual(["ip-p", "ip-a"]);
    expect(await ids(viewer)).toEqual(["ip-a"]);
    // The join used for the visibility rule never leaks into the result.
    const [first] = await eventImpactPriors(null, { eventId: "ev-1" }, ctx(admin, prisma));
    expect(first).not.toHaveProperty("task");
  });
});
