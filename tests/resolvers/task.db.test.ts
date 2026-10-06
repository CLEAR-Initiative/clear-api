/**
 * Integration tests for the Task / Worker protocol against the real, migrated
 * schema (ADR-0010).
 *
 * The DB-free suite stubs Prisma, so it can't catch a wrong column, the
 * partial unique index, or the raw `FOR UPDATE SKIP LOCKED` claim. These run
 * the add_tasks_and_impact_priors migration for real: the tracer bullet
 * (request → claim → complete → the ImpactPrior beside the Event), and the
 * claim's atomicity under concurrency.
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

const { requestEventEnrichment, claimTasks, heartbeatTask, completeTask, failTask, cancelTask } = taskResolvers.Mutation;
const { eventTasks, eventImpactPriors } = taskResolvers.Query;

const RUN = `task-db-${Date.now()}`;
const ANALYST_ID = `${RUN}-analyst`;
const VIEWER_ID = `${RUN}-viewer`;
const WORKER_A = `${RUN}-worker-a`;
const WORKER_B = `${RUN}-worker-b`;
const COUNTRY_ID = `${RUN}-country`;
const DISTRICT_ID = `${RUN}-district`;

const asUser = (id: string, role: string): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod: "session" }) as unknown as Context;
const analyst = asUser(ANALYST_ID, "analyst");
const viewer = asUser(VIEWER_ID, "viewer");
const workerA = asUser(WORKER_A, "worker");
const workerB = asUser(WORKER_B, "worker");

let eventId: string;
const eventIds: string[] = [];

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
    await prisma.activityLogs.deleteMany({ where: { userId: { in: [ANALYST_ID, VIEWER_ID] } } });
    await prisma.impactPrior.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.task.deleteMany({ where: { subjectType: "event", subjectId: { in: eventIds } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.locations.deleteMany({ where: { id: { in: [DISTRICT_ID, COUNTRY_ID] } } });
    await prisma.user.deleteMany({
      where: { id: { in: [ANALYST_ID, VIEWER_ID, WORKER_A, WORKER_B] } },
    });
  });

  it("tracer bullet: request → claim → complete → the proposed ImpactPrior beside the Event", async () => {
    const requested = await requestEventEnrichment(null, { eventId }, analyst);
    expect(requested).toMatchObject({
      kind: IMPACT_PRIOR_KIND,
      subjectType: "event",
      subjectId: eventId,
      status: "PENDING",
      origin: "user",
      requesterId: ANALYST_ID,
      payload: { horizonYears: 10 },
      attempts: 0,
    });

    const [claimed] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    expect(claimed.id).toBe(requested.id);
    expect(claimed).toMatchObject({ status: "LEASED", leaseOwnerId: WORKER_A, attempts: 1 });
    expect(claimed.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    // The token is the owner's secret: the requester reading eventTasks never sees it.
    const [seenByRequester] = await eventTasks(null, { eventId }, analyst);
    expect(taskResolvers.Task.leaseToken(seenByRequester, null, analyst)).toBeNull();
    expect(taskResolvers.Task.leaseToken(claimed, null, workerA)).toBe(claimed.leaseToken);
    expect(claimed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);

    // Nothing left for a second Worker.
    expect(await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerB)).toEqual([]);

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

    // The Event page's reads.
    const tasks = await eventTasks(null, { eventId }, analyst);
    expect(tasks.map((t) => t.id)).toEqual([done.id]);
    const priors = await eventImpactPriors(null, { eventId }, analyst);
    expect(priors).toHaveLength(1);
    expect(priors[0]).toMatchObject({
      eventId,
      taskId: done.id,
      state: "proposed",
      hazardType: "FL",
      countryLocationId: COUNTRY_ID,
      numberOfCases: 1,
      supersedesId: null,
    });
    // A viewer sees the Task but not the proposed ImpactPrior.
    expect(await eventTasks(null, { eventId }, viewer)).toHaveLength(1);
    expect(await eventImpactPriors(null, { eventId }, viewer)).toEqual([]);
  });

  it("two Workers claiming at once never hold the same Task", async () => {
    const ids = await Promise.all([makeEvent(), makeEvent(), makeEvent()]);
    const requested = [];
    for (const id of ids) {
      requested.push((await requestEventEnrichment(null, { eventId: id }, analyst)).id);
    }

    const [a, b] = await Promise.all([
      claimTasks(null, { kind: IMPACT_PRIOR_KIND, limit: 2 }, workerA),
      claimTasks(null, { kind: IMPACT_PRIOR_KIND, limit: 2 }, workerB),
    ]);
    const held = [...a, ...b].map((t) => t.id);
    expect(held).toHaveLength(3);
    expect(new Set(held).size).toBe(3);
    expect(new Set(held)).toEqual(new Set(requested));
    for (const t of a) expect(t.leaseOwnerId).toBe(WORKER_A);
    for (const t of b) expect(t.leaseOwnerId).toBe(WORKER_B);
    expect(await claimTasks(null, { kind: IMPACT_PRIOR_KIND, limit: 5 }, workerA)).toEqual([]);

    for (const t of [...a, ...b]) {
      await completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: {} }, t.leaseOwnerId === WORKER_A ? workerA : workerB);
    }
  });

  it("a second request returns the open Task; after completion a new request opens a new one", async () => {
    const id = await makeEvent();
    const first = await requestEventEnrichment(null, { eventId: id, horizonYears: 4 }, analyst);
    const again = await requestEventEnrichment(null, { eventId: id, horizonYears: 9 }, analyst);
    expect(again.id).toBe(first.id);
    expect(again.payload).toEqual({ horizonYears: 4 });
    const [claimed] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    expect((await requestEventEnrichment(null, { eventId: id }, analyst)).id).toBe(first.id);
    await completeTask(null, { id: claimed.id, leaseToken: claimed.leaseToken!, result: {} }, workerA);
    const second = await requestEventEnrichment(null, { eventId: id }, analyst);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("PENDING");
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
    const [again2] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    expect(again2.id).toBe(second.id);
    await completeTask(null, { id: second.id, leaseToken: again2.leaseToken!, result: {} }, workerA);
  });

  /** Age a lease so the next claim sees it as lapsed. */
  const expireLease = (id: string) =>
    prisma.task.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() - 60_000) } });

  it("heartbeat extends the lease; a lapsed lease is reclaimed by the next claim and the old owner is locked out", async () => {
    const id = await makeEvent();
    const requested = await requestEventEnrichment(null, { eventId: id }, analyst);
    const [a] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    expect(a.id).toBe(requested.id);

    const beat = await heartbeatTask(null, { id: a.id, leaseToken: a.leaseToken! }, workerA);
    expect(beat.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(a.leaseExpiresAt!.getTime());
    expect(beat.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    // Another Worker gets nothing while the lease is live.
    expect(await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerB)).toEqual([]);

    await expireLease(a.id);
    const [b] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerB);
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
    const requested = await requestEventEnrichment(null, { eventId: id }, analyst);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [t] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, attempt % 2 ? workerA : workerB);
      expect(t).toMatchObject({ id: requested.id, attempts: attempt });
      await expireLease(t.id);
    }
    expect(await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA)).toEqual([]);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: requested.id } });
    expect(row).toMatchObject({
      status: "FAILED",
      attempts: 3,
      lastError: "lease expired after max attempts",
      leaseExpiresAt: null,
    });
    // Visible to the requester on the Event page; redacted for a viewer.
    expect((await eventTasks(null, { eventId: id }, analyst))[0].lastError).toBe("lease expired after max attempts");
    expect((await eventTasks(null, { eventId: id }, viewer))[0].lastError).toBeNull();
  });

  it("failTask retries until maxAttempts, then FAILED with the last error visible to the requester", async () => {
    const id = await makeEvent();
    const requested = await requestEventEnrichment(null, { eventId: id }, analyst);
    const [first] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    const retry = await failTask(null, { id: first.id, leaseToken: first.leaseToken!, error: "attempt 1 failed" }, workerA);
    expect(retry).toMatchObject({ status: "PENDING", attempts: 1, lastError: "attempt 1 failed", leaseOwnerId: null });
    // Still the one open Task for the Event: a new request dedupes onto it.
    expect((await requestEventEnrichment(null, { eventId: id }, analyst)).id).toBe(requested.id);

    const [second] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerB);
    expect(second).toMatchObject({ id: requested.id, attempts: 2, leaseOwnerId: WORKER_B });
    await failTask(null, { id: second.id, leaseToken: second.leaseToken!, error: "attempt 2 failed" }, workerB);
    const [third] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    expect(third.attempts).toBe(3);
    const failed = await failTask(null, { id: third.id, leaseToken: third.leaseToken!, error: "attempt 3 failed" }, workerA);
    expect(failed).toMatchObject({ status: "FAILED", attempts: 3, lastError: "attempt 3 failed", leaseOwnerId: WORKER_A });

    expect(await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerB)).toEqual([]);
    expect((await eventTasks(null, { eventId: id }, analyst))[0].lastError).toBe("attempt 3 failed");
    expect((await eventTasks(null, { eventId: id }, viewer))[0].lastError).toBeNull();
    // FAILED is terminal history: a new request opens a fresh Task.
    const again = await requestEventEnrichment(null, { eventId: id }, analyst);
    expect(again.id).not.toBe(requested.id);
    const [t] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    await completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: {} }, workerA);
  });

  it("cancel: PENDING ends now; LEASED is flagged, never re-claimed, and finished by the Worker", async () => {
    const pendingEvent = await makeEvent();
    const pending = await requestEventEnrichment(null, { eventId: pendingEvent }, analyst);
    const cancelled = await cancelTask(null, { id: pending.id }, analyst);
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelledById: ANALYST_ID });
    expect(await claimTasks(null, { kind: IMPACT_PRIOR_KIND, limit: 10 }, workerA)).toEqual([]);
    // CANCELLED is history: the Event can be requested again.
    const fresh = await requestEventEnrichment(null, { eventId: pendingEvent }, analyst);
    expect(fresh.id).not.toBe(pending.id);

    const [held] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    expect(held.id).toBe(fresh.id);
    await expect(cancelTask(null, { id: held.id }, viewer)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const flagged = await cancelTask(null, { id: held.id }, analyst);
    expect(flagged).toMatchObject({ status: "LEASED", leaseOwnerId: WORKER_A });
    expect(flagged.cancelRequestedAt).toBeInstanceOf(Date);
    // A lapsed, flagged lease is not handed to another Worker.
    await expireLease(held.id);
    expect(await claimTasks(null, { kind: IMPACT_PRIOR_KIND, limit: 10 }, workerB)).toEqual([]);
    // The Worker's completion is discarded and the Task ends CANCELLED.
    const done = await completeTask(null, { id: held.id, leaseToken: held.leaseToken!, result: { late: true } }, workerA);
    expect(done).toMatchObject({ status: "CANCELLED", result: null, leaseExpiresAt: null });
    expect(await prisma.impactPrior.count({ where: { taskId: held.id } })).toBe(0);
    await expect(cancelTask(null, { id: held.id }, analyst)).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
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
    await requestEventEnrichment(null, { eventId: id }, analyst);
    let [t] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
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
    await requestEventEnrichment(null, { eventId: id }, analyst);
    [t] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    await completeTask(null, { id: t.id, leaseToken: t.leaseToken!, result: {}, impactPrior: proposal, usage }, workerA);
    await requestEventEnrichment(null, { eventId: id }, analyst);
    [t] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerB);
    await completeTask(
      null,
      { id: t.id, leaseToken: t.leaseToken!, result: {}, impactPrior: { ...proposal, numberOfCases: 2, basis: [...proposal.basis, { tier: "web", sourceUrl: "https://example.test", scope: "country" }] } },
      workerB,
    );
    const priors = await eventImpactPriors(null, { eventId: id }, analyst);
    expect(priors).toHaveLength(2);
    const [newest, first] = priors;
    expect(newest).toMatchObject({ numberOfCases: 2, supersedesId: first.id, state: "proposed" });
    expect(first).toMatchObject({ numberOfCases: 1, supersedesId: null, state: "proposed" });
    // The earlier row is untouched, and the chain resolves.
    expect(await taskResolvers.ImpactPrior.supersedes(newest, null, analyst)).toMatchObject({ id: first.id });
  });

  it("the partial unique index allows one open Task per Event and kind, and history rows beside it", async () => {
    const id = await makeEvent();
    const first = await requestEventEnrichment(null, { eventId: id }, analyst);
    await expect(
      prisma.task.create({
        data: { kind: IMPACT_PRIOR_KIND, subjectType: "event", subjectId: id, payload: {} },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const [claimed] = await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerA);
    expect(claimed.id).toBe(first.id);
    await completeTask(null, { id: first.id, leaseToken: claimed.leaseToken!, result: {} }, workerA);
    // Once COMPLETED, a new open Task for the same Event is allowed.
    const second = await requestEventEnrichment(null, { eventId: id }, analyst);
    expect(second.id).not.toBe(first.id);
  });
});
