/**
 * Integration tests for the Task / Worker protocol against the real, migrated
 * schema (ADR-0010).
 *
 * The DB-free suite stubs Prisma, so it can't catch a wrong column, the
 * partial unique index, or the raw `FOR UPDATE SKIP LOCKED` claim. These run
 * the Task migrations for real: the tracer bullet (request → claim →
 * complete → the ImpactPrior beside the Event), the claim's atomicity under
 * concurrency, and the fan-out (one Task per source kind, proposals from
 * several Workers side by side, supersession within a kind).
 *
 * A request fans out into the default kinds, `.clear` and `.web`. Most
 * tests drive the `.clear` Task and leave the `.web` one PENDING; the
 * parallel-proposals test drains the `.web` pool to reach its own.
 *
 * Self-seeding: every row hangs off a fresh Event and fresh users, deleted
 * in afterAll (Tasks and ImpactPriors are never deleted by the API, so the
 * cleanup goes through Prisma directly), so this runs against an empty
 * scratch database: `bun run test:db tests/resolvers/task.db.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { taskResolvers, IMPACT_PRIOR_KIND } from "../../src/resolvers/task.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { requestEventEnrichment, claimTasks, heartbeatTask, completeTask, failTask, cancelTask, decideImpactPrior } =
  taskResolvers.Mutation;
const { eventTasks, eventImpactPriors, eventCaseProposals, caseProposals, rejectedCaseUrls, impactPriors } =
  taskResolvers.Query;

const RUN = `task-db-${Date.now()}`;
const ANALYST_ID = `${RUN}-analyst`;
/** A second requester: the per-requester daily cap (20) is real, and this
 *  suite makes more requests than that. */
const ANALYST_B_ID = `${RUN}-analyst-b`;
const VIEWER_ID = `${RUN}-viewer`;
const WORKER_A = `${RUN}-worker-a`;
const WORKER_B = `${RUN}-worker-b`;
const ADMIN_ID = `${RUN}-admin`;
const COUNTRY_ID = `${RUN}-country`;
const DISTRICT_ID = `${RUN}-district`;
/** The default fan-out (TASK_IMPACT_PRIOR_KINDS). */
const CLEAR_KIND = "event.impact_prior.clear";
const WEB_KIND = "event.impact_prior.web";

const asUser = (id: string, role: string): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod: "session" }) as unknown as Context;
const analyst = asUser(ANALYST_ID, "analyst");
const analystB = asUser(ANALYST_B_ID, "analyst");
const viewer = asUser(VIEWER_ID, "viewer");
const workerA = asUser(WORKER_A, "worker");
const workerB = asUser(WORKER_B, "worker");

let eventId: string;
const eventIds: string[] = [];

/** Request enrichment and pick out the per-source Tasks the fan-out created. */
async function request(id: string, as: Context, args: { horizonYears?: number } = {}) {
  const tasks = await requestEventEnrichment(null, { eventId: id, ...args }, as);
  const byKind = new Map(tasks.map((t) => [t.kind, t]));
  return { tasks, clear: byKind.get(CLEAR_KIND)!, web: byKind.get(WEB_KIND)! };
}

/** Claim Tasks of `kind` (oldest first) until `id` is held, completing the
 *  leftovers earlier tests left PENDING with no proposal. */
async function claimOwn(kind: string, id: string, as: Context) {
  for (let round = 0; round < 10; round++) {
    const claimed = await claimTasks(null, { kind, limit: 10 }, as);
    if (claimed.length === 0) break;
    let mine: (typeof claimed)[number] | undefined;
    for (const t of claimed) {
      if (t.id === id) mine = t;
      else await completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: { leftover: true } }, as);
    }
    if (mine) return mine;
  }
  throw new Error(`never claimed ${kind} Task ${id}`);
}

/** The `.clear` Task's view on the Event page: eventTasks is newest-first
 *  and the fan-out leaves a `.web` sibling beside it. */
const clearTaskSeenBy = async (id: string, taskId: string, as: Context) =>
  (await eventTasks(null, { eventId: id }, as)).find((t) => t.id === taskId)!;

async function makeEvent(): Promise<string> {
  const at = new Date();
  const row = await prisma.events.create({
    data: {
      types: ["FL"],
      validTo: at,
      firstSignalCreatedAt: at,
      lastSignalCreatedAt: at,
      rank: 0,
      locationId: DISTRICT_ID,
    },
  });
  eventIds.push(row.id);
  return row.id;
}

describeIfDb("Tasks against the real schema", () => {
  beforeAll(async () => {
    for (const [id, role] of [
      [ANALYST_ID, "analyst"],
      [ANALYST_B_ID, "analyst"],
      [ADMIN_ID, "admin"],
      [VIEWER_ID, "viewer"],
      [WORKER_A, "worker"],
      [WORKER_B, "worker"],
    ]) {
      await prisma.user.create({
        data: { id, name: id, email: `${id}@example.test`, role },
      });
    }
    // A country and a district under it (no geometry needed for Tasks).
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY_ID}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${DISTRICT_ID}, 'Testville', 2, ${COUNTRY_ID}, ARRAY[${COUNTRY_ID}]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
    eventId = await makeEvent();
  });

  afterAll(async () => {
    await prisma.activityLogs.deleteMany({ where: { userId: { in: [ANALYST_ID, ANALYST_B_ID, VIEWER_ID] } } });
    await prisma.notifications.deleteMany({ where: { userId: { in: [ANALYST_ID, ANALYST_B_ID, VIEWER_ID, ADMIN_ID] } } });
    await prisma.caseProposal.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.impactPrior.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.task.deleteMany({ where: { subjectType: "event", subjectId: { in: eventIds } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.locations.deleteMany({ where: { id: { in: [DISTRICT_ID, COUNTRY_ID] } } });
    await prisma.user.deleteMany({
      where: { id: { in: [ANALYST_ID, ANALYST_B_ID, VIEWER_ID, WORKER_A, WORKER_B, ADMIN_ID] } },
    });
  });

  it("tracer bullet: request → claim → complete → the proposed ImpactPrior beside the Event", async () => {
    const { tasks: fanned, clear: requested, web } = await request(eventId, analyst);
    // The fan-out: one Task per enabled source kind, in configured order, one requestId.
    expect(fanned.map((t) => t.kind)).toEqual([CLEAR_KIND, WEB_KIND]);
    expect(web.requestId).toBe(requested.requestId);
    expect(requested).toMatchObject({
      kind: CLEAR_KIND,
      subjectType: "event",
      subjectId: eventId,
      status: "PENDING",
      origin: "user",
      requesterId: ANALYST_ID,
      payload: { horizonYears: 10 },
      attempts: 0,
    });

    const [claimed] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    expect(claimed.id).toBe(requested.id);
    expect(claimed).toMatchObject({ status: "LEASED", leaseOwnerId: WORKER_A, attempts: 1 });
    expect(claimed.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    // The token is the owner's secret: the requester reading eventTasks never sees it.
    const [seenByRequester] = await eventTasks(null, { eventId }, analyst);
    expect(taskResolvers.Task.leaseToken(seenByRequester, null, analyst)).toBeNull();
    expect(taskResolvers.Task.leaseToken(claimed, null, workerA)).toBe(claimed.leaseToken);
    expect(claimed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);

    // Nothing left for a second Worker.
    expect(await claimTasks(null, { kind: CLEAR_KIND }, workerB)).toEqual([]);

    const done = await completeTask(
      null,
      {
        id: claimed.id,
        leaseToken: claimed.leaseToken!,
        result: { summary: "one prior flood" },
        impactPrior: {
          hazardType: "FL",
          countryLocationId: COUNTRY_ID,
          geographicScope: "country",
          horizonYears: 10,
          numberOfCases: 1,
          basis: [{ tier: "web", sourceUrl: "https://example.test/flood-2021", quote: "…", scope: "country" }],
          methodVersion: "clear-impact-prior@0.1.0",
        },
      },
      workerA,
    );
    expect(done).toMatchObject({
      status: "COMPLETED",
      outcome: "produced",
      result: { summary: "one prior flood" },
      leaseOwnerId: WORKER_A,
      leaseExpiresAt: null,
    });
    expect(done.completedAt).toBeInstanceOf(Date);

    // The fan-out: the requester and the platform admin were told in-app, with a link to the Event.
    let rows: { userId: string; actionUrl: string | null; notificationType: string }[] = [];
    for (let i = 0; i < 20 && rows.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 25));
      rows = await prisma.notifications.findMany({ where: { notificationType: "task", actionUrl: `/event/${eventId}` } });
    }
    expect(rows.map((r) => r.userId).sort()).toEqual([ADMIN_ID, ANALYST_ID].sort());

    // The Event page's reads: both Tasks, one proposal so far (the .web Worker has not reported).
    const tasks = await eventTasks(null, { eventId }, analyst);
    expect(tasks.map((t) => t.id).sort()).toEqual([done.id, web.id].sort());
    const priors = await eventImpactPriors(null, { eventId }, analyst);
    expect(priors).toHaveLength(1);
    expect(priors[0]).toMatchObject({
      eventId,
      taskId: done.id,
      sourceKind: CLEAR_KIND,
      state: "proposed",
      hazardType: "FL",
      countryLocationId: COUNTRY_ID,
      numberOfCases: 1,
      supersedesId: null,
    });
    // A viewer sees the Tasks but not the proposed ImpactPrior.
    expect(await eventTasks(null, { eventId }, viewer)).toHaveLength(2);
    expect(await eventImpactPriors(null, { eventId }, viewer)).toEqual([]);
  });

  it("two Workers claiming at once never hold the same Task", async () => {
    const ids = await Promise.all([makeEvent(), makeEvent(), makeEvent()]);
    const requested = [];
    for (const id of ids) {
      requested.push((await request(id, analyst)).clear.id);
    }

    const [a, b] = await Promise.all([
      claimTasks(null, { kind: CLEAR_KIND, limit: 2 }, workerA),
      claimTasks(null, { kind: CLEAR_KIND, limit: 2 }, workerB),
    ]);
    const held = [...a, ...b].map((t) => t.id);
    expect(held).toHaveLength(3);
    expect(new Set(held).size).toBe(3);
    expect(new Set(held)).toEqual(new Set(requested));
    for (const t of a) expect(t.leaseOwnerId).toBe(WORKER_A);
    for (const t of b) expect(t.leaseOwnerId).toBe(WORKER_B);
    expect(await claimTasks(null, { kind: CLEAR_KIND, limit: 5 }, workerA)).toEqual([]);

    for (const t of [...a, ...b]) {
      await completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: {} }, t.leaseOwnerId === WORKER_A ? workerA : workerB);
    }
  });

  it("a second request returns the open Task; after completion a new request opens a new one", async () => {
    const id = await makeEvent();
    const { clear: first, web: firstWeb } = await request(id, analyst, { horizonYears: 4 });
    const { clear: again, web: againWeb } = await request(id, analyst, { horizonYears: 9 });
    expect(again.id).toBe(first.id);
    expect(againWeb.id).toBe(firstWeb.id);
    expect(again.payload).toEqual({ horizonYears: 4 });
    const [claimed] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    expect((await request(id, analyst)).clear.id).toBe(first.id);
    await completeTask(null, { id: claimed.id, leaseToken: claimed.leaseToken!, result: {} }, workerA);
    // Dedupe is per kind: only .clear is re-created; the still-open .web Task is returned as is.
    const { clear: second, web: secondWeb } = await request(id, analyst);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("PENDING");
    expect(secondWeb.id).toBe(firstWeb.id);
    expect(second.requestId).not.toBe(first.requestId);
    // logActivity is fire-and-forget: give it a moment to land.
    let log: { id: string }[] = [];
    for (let i = 0; i < 20 && log.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 25));
      log = await prisma.activityLogs.findMany({
        where: { action: "task.requested", resourceId: { in: [first.id, second.id] } },
      });
    }
    expect(log).toHaveLength(2);
    // Leave the pool empty for the next test (claims are oldest-first).
    const [again2] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    expect(again2.id).toBe(second.id);
    await completeTask(null, { id: second.id, leaseToken: again2.leaseToken!, result: {} }, workerA);
  });

  /** Age a lease so the next claim sees it as lapsed. */
  const expireLease = (id: string) =>
    prisma.task.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() - 60_000) } });

  it("heartbeat extends the lease; a lapsed lease is reclaimed by the next claim and the old owner is locked out", async () => {
    const id = await makeEvent();
    const { clear: requested } = await request(id, analyst);
    const [a] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    expect(a.id).toBe(requested.id);

    const beat = await heartbeatTask(null, { id: a.id, leaseToken: a.leaseToken! }, workerA);
    expect(beat.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(a.leaseExpiresAt!.getTime());
    expect(beat.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    // Another Worker gets nothing while the lease is live.
    expect(await claimTasks(null, { kind: CLEAR_KIND }, workerB)).toEqual([]);

    await expireLease(a.id);
    const [b] = await claimTasks(null, { kind: CLEAR_KIND }, workerB);
    expect(b).toMatchObject({ id: a.id, status: "LEASED", leaseOwnerId: WORKER_B, attempts: 2 });
    expect(b.leaseToken).not.toBe(a.leaseToken);

    // The old owner is told it no longer holds the lease, on every write.
    await expect(heartbeatTask(null, { id: a.id, leaseToken: a.leaseToken! }, workerA)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN", subCode: "NOT_LEASE_OWNER" },
    });
    await expect(completeTask(null, { id: a.id, leaseToken: a.leaseToken!, result: { stale: true } }, workerA)).rejects.toMatchObject({
      extensions: { subCode: "NOT_LEASE_OWNER" },
    });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ status: "LEASED", leaseOwnerId: WORKER_B, result: null });

    await completeTask(null, { id: a.id, leaseToken: b.leaseToken!, result: {} }, workerB);
  });

  it("a lapsed lease on a Task out of attempts is marked FAILED at the next claim, not handed out again", async () => {
    const id = await makeEvent();
    const { clear: requested } = await request(id, analyst);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [t] = await claimTasks(null, { kind: CLEAR_KIND }, attempt % 2 ? workerA : workerB);
      expect(t).toMatchObject({ id: requested.id, attempts: attempt });
      await expireLease(t.id);
    }
    expect(await claimTasks(null, { kind: CLEAR_KIND }, workerA)).toEqual([]);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: requested.id } });
    expect(row).toMatchObject({
      status: "FAILED",
      attempts: 3,
      lastError: "lease expired after max attempts",
      leaseExpiresAt: null,
    });
    // Visible to the requester on the Event page; redacted for a viewer.
    expect((await clearTaskSeenBy(id, requested.id, analyst)).lastError).toBe("lease expired after max attempts");
    expect((await clearTaskSeenBy(id, requested.id, viewer)).lastError).toBeNull();
  });

  it("failTask retries until maxAttempts, then FAILED with the last error visible to the requester", async () => {
    const id = await makeEvent();
    const { clear: requested } = await request(id, analyst);
    const [first] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    const retry = await failTask(null, { id: first.id, leaseToken: first.leaseToken!, error: "attempt 1 failed" }, workerA);
    expect(retry).toMatchObject({ status: "PENDING", attempts: 1, lastError: "attempt 1 failed", leaseOwnerId: null });
    // Still the one open Task for the Event: a new request dedupes onto it.
    expect((await request(id, analyst)).clear.id).toBe(requested.id);

    const [second] = await claimTasks(null, { kind: CLEAR_KIND }, workerB);
    expect(second).toMatchObject({ id: requested.id, attempts: 2, leaseOwnerId: WORKER_B });
    await failTask(null, { id: second.id, leaseToken: second.leaseToken!, error: "attempt 2 failed" }, workerB);
    const [third] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    expect(third.attempts).toBe(3);
    const failed = await failTask(null, { id: third.id, leaseToken: third.leaseToken!, error: "attempt 3 failed" }, workerA);
    expect(failed).toMatchObject({ status: "FAILED", attempts: 3, lastError: "attempt 3 failed", leaseOwnerId: WORKER_A });

    expect(await claimTasks(null, { kind: CLEAR_KIND }, workerB)).toEqual([]);
    expect((await clearTaskSeenBy(id, requested.id, analyst)).lastError).toBe("attempt 3 failed");
    expect((await clearTaskSeenBy(id, requested.id, viewer)).lastError).toBeNull();
    // FAILED is terminal history: a new request opens a fresh Task.
    const { clear: again } = await request(id, analyst);
    expect(again.id).not.toBe(requested.id);
    const [t] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    await completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: {} }, workerA);
  });

  it("cancel: PENDING ends now; LEASED is flagged, never re-claimed, and finished by the Worker", async () => {
    const pendingEvent = await makeEvent();
    const { clear: pending } = await request(pendingEvent, analyst);
    const cancelled = await cancelTask(null, { id: pending.id }, analyst);
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelledById: ANALYST_ID });
    expect(await claimTasks(null, { kind: CLEAR_KIND, limit: 10 }, workerA)).toEqual([]);
    // CANCELLED is history: the Event can be requested again.
    const { clear: fresh } = await request(pendingEvent, analyst);
    expect(fresh.id).not.toBe(pending.id);

    const [held] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    expect(held.id).toBe(fresh.id);
    await expect(cancelTask(null, { id: held.id }, viewer)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const flagged = await cancelTask(null, { id: held.id }, analyst);
    expect(flagged).toMatchObject({ status: "LEASED", leaseOwnerId: WORKER_A });
    expect(flagged.cancelRequestedAt).toBeInstanceOf(Date);
    // The Worker's completion is discarded and the Task ends CANCELLED.
    const done = await completeTask(null, { id: held.id, leaseToken: held.leaseToken!, result: { late: true } }, workerA);
    expect(done).toMatchObject({ status: "CANCELLED", result: null, leaseExpiresAt: null });
    expect(await prisma.impactPrior.count({ where: { taskId: held.id } })).toBe(0);
    await expect(cancelTask(null, { id: held.id }, analyst)).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });

  it("a flagged Task whose Worker died is finished at the next claim, and the Event is requestable again", async () => {
    const id = await makeEvent();
    await request(id, analyst);
    const [held] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    await cancelTask(null, { id: held.id }, analyst);
    await expireLease(held.id);
    // Not handed out, but finished: CANCELLED, so the Event is free again.
    expect(await claimTasks(null, { kind: CLEAR_KIND, limit: 10 }, workerB)).toEqual([]);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("CANCELLED");
    const { clear: fresh } = await request(id, analyst);
    expect(fresh.id).not.toBe(held.id);

    // And cancelling a lapsed lease directly ends it at once, no claim needed.
    const [held2] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    expect(held2.id).toBe(fresh.id);
    await expireLease(held2.id);
    const ended = await cancelTask(null, { id: held2.id }, analyst);
    expect(ended).toMatchObject({ status: "CANCELLED", leaseExpiresAt: null, cancelledById: ANALYST_ID });
    await expect(
      heartbeatTask(null, { id: held2.id, leaseToken: held2.leaseToken! }, workerA),
    ).rejects.toMatchObject({ extensions: { subCode: "NOT_LEASED" } });
  });

  it("validates a proposal against the Event, records no_prior_found and usage, and supersedes rather than overwrites", async () => {
    const id = await makeEvent();
    const proposal = {
      hazardType: "FL",
      countryLocationId: COUNTRY_ID,
      geographicScope: "district",
      horizonYears: 10,
      numberOfCases: 1,
      basis: [{ tier: "clear", eventId: "some-earlier-event", scope: "district" }],
      methodVersion: "clear-impact-prior@0.1.0",
    };
    const usage = { model: "anthropic/claude-sonnet-5-5", inputTokens: 900, outputTokens: 120, costUsd: 0.0045 };

    // Wrong hazard / wrong country are refused and the Task stays LEASED.
    await request(id, analyst);
    let [t] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    await expect(
      completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: {}, impactPrior: { ...proposal, hazardType: "EQ" } }, workerA),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: {}, impactPrior: { ...proposal, countryLocationId: DISTRICT_ID } }, workerA),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("LEASED");

    // No cases: no_prior_found, usage recorded, no row.
    const none = await completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: { cases: 0 }, usage }, workerA);
    expect(none).toMatchObject({ status: "COMPLETED", outcome: "no_prior_found", ...usage });
    expect(await eventImpactPriors(null, { eventId: id }, analyst)).toEqual([]);

    // A second request → first ImpactPrior; a third → one that supersedes it.
    await request(id, analyst);
    [t] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    await completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: {}, impactPrior: proposal, usage }, workerA);
    await request(id, analyst);
    [t] = await claimTasks(null, { kind: CLEAR_KIND }, workerB);
    await completeTask(
      null,
      { id: t.id, leaseToken: t.leaseToken!, result: {}, impactPrior: { ...proposal, numberOfCases: 2, basis: [...proposal.basis, { tier: "web", sourceUrl: "https://example.test", scope: "country" }] } },
      workerB,
    );
    const priors = await eventImpactPriors(null, { eventId: id }, analyst);
    expect(priors).toHaveLength(2);
    const [newest, first] = priors;
    expect(newest).toMatchObject({ numberOfCases: 2, supersedesId: first.id, state: "proposed", sourceKind: CLEAR_KIND });
    expect(first).toMatchObject({ numberOfCases: 1, supersedesId: null, state: "proposed", sourceKind: CLEAR_KIND });
    // The earlier row is untouched, and the chain resolves.
    expect(await taskResolvers.ImpactPrior.supersedes(newest, null, analyst)).toMatchObject({ id: first.id });
  });

  it("decideImpactPrior records a decision once; a later request supersedes rather than overwrites", async () => {
    const id = await makeEvent();
    const proposal = {
      hazardType: "FL", countryLocationId: COUNTRY_ID, geographicScope: "country", horizonYears: 10,
      numberOfCases: 1, basis: [{ tier: "web", sourceUrl: "https://example.test", scope: "country" }],
      methodVersion: "clear-impact-prior@0.1.0",
    };
    await request(id, analystB);
    const [t] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    await completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: {}, impactPrior: proposal }, workerA);
    const [prior] = await eventImpactPriors(null, { eventId: id }, analyst);

    await expect(decideImpactPrior(null, { id: prior.id, decision: "accepted", rationale: "x" }, viewer)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    const rejected = await decideImpactPrior(null, { id: prior.id, decision: "rejected", rationale: "Wrong season." }, analystB);
    expect(rejected).toMatchObject({ state: "rejected", decidedById: ANALYST_B_ID, decisionRationale: "Wrong season." });
    expect(rejected.decidedAt).toBeInstanceOf(Date);
    await expect(decideImpactPrior(null, { id: prior.id, decision: "accepted", rationale: "y" }, analyst)).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });

    // The rejected row stays; a new request produces a superseding proposal pointing at it.
    await request(id, analystB);
    const [t2] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    await completeTask(null, { id: t2.id, leaseToken: t2.leaseToken!, result: {}, impactPrior: proposal }, workerA);
    const priors = await eventImpactPriors(null, { eventId: id }, analyst);
    expect(priors.map((p) => p.state)).toEqual(["proposed", "rejected"]);
    expect(priors[0].supersedesId).toBe(prior.id);
    // The decision is on the activity log (fire-and-forget: give it a moment).
    let log: { metadata: unknown }[] = [];
    for (let i = 0; i < 20 && log.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 25));
      log = await prisma.activityLogs.findMany({ where: { action: "impact_prior.decided", resourceId: prior.id } });
    }
    expect(log).toHaveLength(1);
    expect(log[0].metadata).toMatchObject({ decision: "rejected", eventId: id });
  });

  it("a web Worker's cases land one row each; a URL already proposed for the Event is skipped (V4)", async () => {
    const id = await makeEvent();
    const pastId = await makeEvent();
    const { web, clear } = await request(id, analystB);
    // Only the web Worker matters here; leave nothing for later tests' claims.
    await cancelTask(null, { id: clear.id }, analystB);
    const held = await claimOwn(WEB_KIND, web.id, workerB);
    const at = new Date(Date.now() - 400 * 24 * 3600_000);
    const done = await completeTask(
      null,
      {
        id: held.id,
        leaseToken: held.leaseToken!,
        result: { searched: 4 },
        methodVersion: "clear-impact-prior-web@0.4.0",
        cases: [
          {
            sourceUrl: "https://example.test/case-a",
            quote: "Floods displaced 4,000 people.",
            occurredAt: at,
            locationLabel: "Testville",
            locationId: DISTRICT_ID,
            hazardType: "FL",
            geographicScope: "district",
            figures: [{ metric: "people_displaced_new", value: 4000 }],
            matchedEventId: pastId,
          },
          {
            sourceUrl: "https://example.test/case-b",
            quote: "Rivers burst their banks.",
            occurredAt: at,
            locationLabel: "Testland",
            hazardType: "FL",
            geographicScope: "country",
          },
        ],
      },
      workerB,
    );
    expect(done).toMatchObject({ status: "COMPLETED", outcome: "produced" });
    expect(await prisma.impactPrior.count({ where: { taskId: held.id } })).toBe(0);

    const seen = await eventCaseProposals(null, { eventId: id }, analystB);
    expect(seen.map((c) => c.sourceUrl).sort()).toEqual(["https://example.test/case-a", "https://example.test/case-b"]);
    const a = seen.find((c) => c.sourceUrl.endsWith("case-a"))!;
    expect(a).toMatchObject({ state: "proposed", matchedEventId: pastId, locationId: DISTRICT_ID, taskId: held.id });
    expect(a.figures).toEqual([{ metric: "people_displaced_new", value: 4000 }]);
    // A viewer sees no proposed case; the Inbox lists them for a decider.
    expect(await eventCaseProposals(null, { eventId: id }, viewer)).toEqual([]);
    const inbox = await caseProposals(null, { limit: 200 }, analyst);
    expect(inbox.filter((c) => c.eventId === id)).toHaveLength(2);

    // A rejected URL is what the Worker asks for before searching again.
    await prisma.caseProposal.update({ where: { id: a.id }, data: { state: "rejected" } });
    expect(await rejectedCaseUrls(null, { eventId: id }, workerA)).toEqual(["https://example.test/case-a"]);

    // A later request re-proposing it is skipped, not an error, and the
    // rejection stands.
    const { web: again, clear: clearAgain } = await request(id, analystB);
    await cancelTask(null, { id: clearAgain.id }, analystB);
    const held2 = await claimOwn(WEB_KIND, again.id, workerB);
    await completeTask(
      null,
      {
        id: held2.id,
        leaseToken: held2.leaseToken!,
        result: {},
        methodVersion: "clear-impact-prior-web@0.4.0",
        cases: [
          { sourceUrl: "https://example.test/case-a", quote: "again", occurredAt: at, locationLabel: "Testville", hazardType: "FL", geographicScope: "district" },
          { sourceUrl: "https://example.test/case-c", quote: "new", occurredAt: at, locationLabel: "Testville", hazardType: "FL", geographicScope: "district" },
        ],
      },
      workerB,
    );
    const after = await prisma.caseProposal.findMany({ where: { eventId: id }, orderBy: { sourceUrl: "asc" } });
    expect(after.map((c) => [c.sourceUrl, c.state])).toEqual([
      ["https://example.test/case-a", "rejected"],
      ["https://example.test/case-b", "proposed"],
      ["https://example.test/case-c", "proposed"],
    ]);
    // Web proposals are decided case by case: the whole-prior Inbox leaves them out.
    expect((await impactPriors(null, { limit: 200 }, analyst)).every((p) => p.sourceKind === CLEAR_KIND)).toBe(true);
  });

  it("the partial unique index allows one open Task per Event and kind, and history rows beside it", async () => {
    const id = await makeEvent();
    const { clear: first, web } = await request(id, analystB);
    await expect(
      prisma.task.create({
        data: { kind: CLEAR_KIND, subjectType: "event", subjectId: id, payload: {}, requestId: `${RUN}-dup` },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Per kind: the .web Task sits open beside the .clear one.
    expect(web.status).toBe("PENDING");

    const [claimed] = await claimTasks(null, { kind: CLEAR_KIND }, workerA);
    expect(claimed.id).toBe(first.id);
    await completeTask(null, { id: first.id, leaseToken: claimed.leaseToken!, result: {} }, workerA);
    // Once COMPLETED, a new open Task for the same Event is allowed.
    const { clear: second } = await request(id, analystB);
    expect(second.id).not.toBe(first.id);
  });

  it("several Workers propose on one Event: sources sit side by side, supersession stays within a kind", async () => {
    const id = await makeEvent();
    const proposal = {
      hazardType: "FL", countryLocationId: COUNTRY_ID, geographicScope: "country", horizonYears: 10,
      numberOfCases: 1, basis: [{ tier: "clear", eventId: "some-earlier-event", scope: "country" }],
      methodVersion: "impact-prior@1.0.0",
    };
    const webProposal = {
      ...proposal,
      basis: [{ tier: "web", sourceUrl: "https://example.test/flood", scope: "country" }],
      methodVersion: "clear-impact-prior@0.3.0",
    };
    const { clear, web } = await request(id, analystB);
    expect(clear.requestId).toBe(web.requestId);

    // Oldest-first claims may hand back an earlier test's leftover first; reach our own.
    const heldClear = await claimOwn(CLEAR_KIND, clear.id, workerA);
    const heldWeb = await claimOwn(WEB_KIND, web.id, workerB);
    await completeTask(null, { id: heldClear.id, leaseToken: heldClear.leaseToken!, result: {}, impactPrior: proposal }, workerA);
    await completeTask(null, { id: heldWeb.id, leaseToken: heldWeb.leaseToken!, result: {}, impactPrior: webProposal }, workerB);

    let priors = await eventImpactPriors(null, { eventId: id }, analyst);
    expect(priors).toHaveLength(2);
    expect(priors.map((p) => p.sourceKind).sort()).toEqual([CLEAR_KIND, WEB_KIND]);
    // Neither supersedes the other: they are siblings, each decided on its own.
    expect(priors.every((p) => p.supersedesId === null && p.state === "proposed")).toBe(true);

    // A second round from the CLEAR Worker supersedes its own earlier proposal only.
    const { clear: clear2, web: web2 } = await request(id, analystB);
    expect(clear2.id).not.toBe(clear.id);
    expect(web2.id).not.toBe(web.id);
    const held2 = await claimOwn(CLEAR_KIND, clear2.id, workerA);
    await completeTask(
      null,
      { id: held2.id, leaseToken: held2.leaseToken!, result: {}, impactPrior: { ...proposal, numberOfCases: 2, basis: [...proposal.basis, { tier: "clear", eventId: "another", scope: "country" }] } },
      workerA,
    );
    priors = await eventImpactPriors(null, { eventId: id }, analyst);
    expect(priors).toHaveLength(3);
    const newestClear = priors.find((p) => p.sourceKind === CLEAR_KIND && p.numberOfCases === 2)!;
    const firstClear = priors.find((p) => p.sourceKind === CLEAR_KIND && p.numberOfCases === 1)!;
    const webPrior = priors.find((p) => p.sourceKind === WEB_KIND)!;
    expect(newestClear.supersedesId).toBe(firstClear.id);
    expect(webPrior.supersedesId).toBeNull();
    expect(await taskResolvers.ImpactPrior.supersedes(newestClear, null, analyst)).toMatchObject({ id: firstClear.id });
    // The .web Task of the second request is still open: nothing marks the Event done.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: web2.id } })).status).toBe("PENDING");
  });

  it("the bare event.impact_prior kind stays claimable and completable for one release, as its own source", async () => {
    const id = await makeEvent();
    const legacy = await prisma.task.create({
      data: {
        kind: IMPACT_PRIOR_KIND, subjectType: "event", subjectId: id, payload: { horizonYears: 10 },
        requestId: `${RUN}-legacy`, requesterId: ANALYST_B_ID, maxAttempts: 3,
      },
    });
    const [held] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    expect(held.id).toBe(legacy.id);
    const done = await completeTask(
      null,
      {
        id: held.id, leaseToken: held.leaseToken!, result: {},
        impactPrior: {
          hazardType: "FL", countryLocationId: COUNTRY_ID, geographicScope: "country", horizonYears: 10,
          numberOfCases: 1, basis: [{ tier: "web", sourceUrl: "https://example.test", scope: "country" }],
          methodVersion: "clear-impact-prior@0.2.0",
        },
      },
      workerA,
    );
    expect(done.outcome).toBe("produced");
    const [prior] = await eventImpactPriors(null, { eventId: id }, analyst);
    expect(prior).toMatchObject({ taskId: legacy.id, sourceKind: IMPACT_PRIOR_KIND, supersedesId: null });
  });
});
