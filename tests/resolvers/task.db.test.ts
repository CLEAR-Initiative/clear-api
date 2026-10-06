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

const { requestEventEnrichment, claimTasks, completeTask } = taskResolvers.Mutation;
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
    expect(claimed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);

    // Nothing left for a second Worker.
    expect(await claimTasks(null, { kind: IMPACT_PRIOR_KIND }, workerB)).toEqual([]);

    const done = await completeTask(
      null,
      {
        id: claimed.id,
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
      await completeTask(null, { id: t.id, result: {} }, t.leaseOwnerId === WORKER_A ? workerA : workerB);
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
    await completeTask(null, { id: claimed.id, result: {} }, workerA);
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
    await completeTask(null, { id: second.id, result: {} }, workerA);
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
    await completeTask(null, { id: first.id, result: {} }, workerA);
    // Once COMPLETED, a new open Task for the same Event is allowed.
    const second = await requestEventEnrichment(null, { eventId: id }, analyst);
    expect(second.id).not.toBe(first.id);
  });
});
