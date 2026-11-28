/**
 * Automatic place research and the cancel on close, against the real schema
 * (ADR-0010 and ADR-0019 amendments, Exponential #1726): the threshold, the
 * daily cap, the wait and its order, no second automatic Task, and each
 * path that closes a row and cancels its Task.
 *
 * Scratch database only: the rule looks at every open row of the queue and
 * counts every automatic Task of the day, so on a developer's database it
 * would create Tasks for real rows. Self-seeding otherwise, and all deleted
 * in afterAll: `bun run test:db tests/resolvers/placeResearchAuto.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { unresolvedPlaceNameResolvers } from "../../src/resolvers/unresolvedPlaceName.resolver.js";
import { placeAliasResolvers } from "../../src/resolvers/placeAlias.resolver.js";
import { taskResolvers } from "../../src/resolvers/task.resolver.js";
import { topUpPlaceResearchTasks } from "../../src/services/place-research.js";
import { PLACE_NAME_SUBJECT, PLACE_RESEARCH_KIND } from "../../src/utils/task-kinds.js";
import { env } from "../../src/utils/env.js";
import type { Context } from "../../src/context.js";
import { describeIfScratchDb } from "../helpers/db.js";

const { recordUnresolvedPlaceName, resolveUnresolvedPlaceName, requestPlaceNameResearch } =
  unresolvedPlaceNameResolvers.Mutation;
const { createPlaceAlias } = placeAliasResolvers.Mutation;
const { claimTasks, completeTask, heartbeatTask } = taskResolvers.Mutation;

const RUN = `pra-db-${Date.now()}`;
// Not an assigned ISO code, so the cleanup by country code reaches only this suite's rows.
const CC = "ZX";
const COUNTRY_ID = `${RUN}-country`;
const STATE_ID = `${RUN}-state`;
const DISTRICT_ID = `${RUN}-district`;
const PLATFORM_ID = `${RUN}-platform`;
const WORKER_ID = `${RUN}-worker`;
const USER_IDS = [PLATFORM_ID, WORKER_ID];

const as = (id: string, role: string, authMethod = "session"): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod, locale: "en", signalScope: { kind: "full" } }) as unknown as Context;
const pipeline = as(`${RUN}-pipeline`, "pipeline", "api-key");
const platform = as(PLATFORM_ID, "admin");
const worker = as(WORKER_ID, "worker", "api-key");

let sourceId: string | undefined;

async function insertArea(id: string, name: string, level: number, parentId: string | null, wkt: string, pCode: string | null = null) {
  const ancestors = parentId
    ? [parentId, ...(await prisma.locations.findUniqueOrThrow({ where: { id: parentId } })).ancestorIds]
    : [];
  await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry", "p_code")
    VALUES (${id}, ${name}, ${level}, ${parentId}, ${ancestors}::text[], ST_GeomFromText(${wkt}, 4326), ${pCode})`;
}

let seq = 0;
/** An open queue row with one real Signal and the signal count set. */
async function queued(name: string, signalCount: number) {
  const signal = await prisma.signals.create({
    data: {
      sourceId: sourceId!,
      rawData: {},
      contentHash: `${RUN}-h${seq}`,
      title: `Post ${seq++}`,
      publishedAt: new Date("2026-11-20T00:00:00.000Z"),
      locationId: STATE_ID,
      countries: { connect: [{ id: COUNTRY_ID }] },
    },
  });
  const row = await recordUnresolvedPlaceName(
    null,
    { input: { signalId: signal.id, name, countryCode: CC, areaLocationId: STATE_ID } },
    pipeline,
  );
  await prisma.unresolvedPlaceNames.update({ where: { id: row!.id }, data: { signalCount } });
  return { ...row!, signalCount, signalId: signal.id };
}

const tasksOf = (rowId: string) =>
  prisma.task.findMany({
    where: { kind: PLACE_RESEARCH_KIND, subjectType: PLACE_NAME_SUBJECT, subjectId: rowId },
    orderBy: { createdAt: "asc" },
  });
const DAY = 24 * 3600_000;
/** Run the rule as on the day `daysFromNow` days ahead: the cap counts from that day's UTC midnight. */
const topUp = (minSignals: number | undefined, dailyCap: number, daysFromNow = 0) =>
  topUpPlaceResearchTasks(prisma, { minSignals, dailyCap, now: new Date(Date.now() + daysFromNow * DAY) });

/** Every Task of this suite's rows is taken out of the way, so each test starts from an empty queue. */
async function clearQueue() {
  const rows = await prisma.unresolvedPlaceNames.findMany({ where: { countryCode: CC }, select: { id: true } });
  const ids = rows.map((r) => r.id);
  await prisma.placeNameProposals.deleteMany({ where: { unresolvedPlaceNameId: { in: ids } } });
  await prisma.task.deleteMany({ where: { subjectType: PLACE_NAME_SUBJECT, subjectId: { in: ids } } });
  await prisma.placeAliases.deleteMany({ where: { countryCode: CC } });
  await prisma.unresolvedPlaceNames.deleteMany({ where: { countryCode: CC } });
}

const FOUND = {
  outcome: "found" as const,
  latitude: 61,
  longitude: 70.5,
  nameFound: "Somewhere",
  confidence: "medium" as const,
  reason: "A settlement list gives it.",
  sources: [{ url: "https://example.org/list", quote: "Somewhere" }],
};

async function claim() {
  const [task] = await claimTasks(null, { kind: PLACE_RESEARCH_KIND, limit: 1 }, worker);
  return task!;
}

describeIfScratchDb("Automatic place research and the cancel on close", () => {
  beforeAll(async () => {
    for (const id of USER_IDS) {
      await prisma.user.create({
        data: { id, name: id, email: `${id}@example.test`, role: id === PLATFORM_ID ? "admin" : "worker" },
      });
    }
    await insertArea(COUNTRY_ID, "Testland", 0, null, "MULTIPOLYGON(((70 60, 74 60, 74 64, 70 64, 70 60)))", CC);
    await insertArea(STATE_ID, "State A", 1, COUNTRY_ID, "MULTIPOLYGON(((70 60, 72 60, 72 64, 70 64, 70 60)))");
    await insertArea(DISTRICT_ID, "District A1", 2, STATE_ID, "MULTIPOLYGON(((70 60, 71 60, 71 62, 70 62, 70 60)))");
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
  });

  afterEach(clearQueue);

  afterAll(async () => {
    await clearQueue();
    await prisma.activityLogs.deleteMany({ where: { userId: { in: USER_IDS } } });
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.locations.deleteMany({ where: { level: 4, ancestorIds: { has: COUNTRY_ID } } });
    await prisma.locations.deleteMany({ where: { level: 2, ancestorIds: { has: COUNTRY_ID } } });
    await prisma.locations.deleteMany({ where: { level: 1, ancestorIds: { has: COUNTRY_ID } } });
    await prisma.locations.deleteMany({ where: { id: COUNTRY_ID } });
    await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
  });

  it("with no threshold the rule is off; with one, a row at or above it gets a Task with the origin rule", async () => {
    const below = await queued("Below", 2);
    const at = await queued("At", 3);
    const above = await queued("Above", 7);

    expect(await topUp(undefined, 10)).toEqual([]);
    expect(await prisma.task.count({ where: { kind: PLACE_RESEARCH_KIND, origin: "rule" } })).toBe(0);

    const created = await topUp(3, 10);
    expect(created.map((t) => t.subjectId)).toEqual([above.id, at.id]);
    expect(await tasksOf(below.id)).toHaveLength(0);
    const [task] = await tasksOf(above.id);
    expect(task).toMatchObject({ status: "PENDING", origin: "rule", requesterId: null, teamId: null });
    // The payload is the one a requested Task carries.
    expect(task!.payload).toEqual({
      name: "Above",
      nameAr: null,
      countryCode: CC,
      stateLocationId: STATE_ID,
      stateName: "State A",
      signalIds: [above.signalId],
    });
    const requested = await requestPlaceNameResearch(null, { id: below.id }, platform);
    expect(Object.keys(requested.payload as object).sort()).toEqual(Object.keys(task!.payload as object).sort());
  });

  it("only an open row with no open Task, no proposal and no earlier automatic Task is due", async () => {
    const ambiguous = await queued("Ambiguous", 9);
    await resolveUnresolvedPlaceName(null, { id: ambiguous.id, resolution: { kind: "AMBIGUOUS" } }, platform);
    const notAPlace = await queued("Not a place", 9);
    await resolveUnresolvedPlaceName(null, { id: notAPlace.id, resolution: { kind: "NOT_A_PLACE" } }, platform);
    // A person asked already: the row has an open Task.
    const asked = await queued("Asked", 9);
    await requestPlaceNameResearch(null, { id: asked.id }, platform);
    // A person's research gave a proposal.
    const proposed = await queued("Proposed", 9);
    await requestPlaceNameResearch(null, { id: proposed.id }, platform);
    const leased = await claim();
    expect(leased.subjectId).toBe(asked.id);
    await prisma.task.update({ where: { id: leased.id }, data: { status: "CANCELLED", leaseExpiresAt: null } });
    const second = await claim();
    expect(second.subjectId).toBe(proposed.id);
    await completeTask(null, { id: second.id, leaseToken: second.leaseToken!, result: {}, place: { outcome: "not_found", reason: "r" }, methodVersion: "m" }, worker);
    const due = await queued("Due", 4);

    // "Asked" has no open Task now (its Task was cancelled) and no proposal,
    // and its Task was a person's: the rule may ask once.
    const created = await topUp(3, 10);
    expect(created.map((t) => t.subjectId)).toEqual([asked.id, due.id]);
    expect(await tasksOf(ambiguous.id)).toHaveLength(0);
    expect(await tasksOf(notAPlace.id)).toHaveLength(0);
    expect((await tasksOf(proposed.id)).filter((t) => t.origin === "rule")).toHaveLength(0);
  });

  it("the cap counts the automatic Tasks of the UTC day; rows over it wait and go first by signal count", async () => {
    const rows = [];
    for (const n of [5, 9, 7, 6, 8]) rows.push(await queued(`Row ${n}`, n));
    const bySignals = (n: number) => rows.find((r) => r.signalCount === n)!.id;
    // A request by a person does not count against the cap.
    const personal = await queued("Personal", 1);
    await requestPlaceNameResearch(null, { id: personal.id }, platform);

    expect((await topUp(3, 2)).map((t) => t.subjectId)).toEqual([bySignals(9), bySignals(8)]);
    // The same day: the cap is spent, and nothing more is created.
    expect(await topUp(3, 2)).toEqual([]);
    expect(await prisma.task.count({ where: { kind: PLACE_RESEARCH_KIND, origin: "rule" } })).toBe(2);

    // A day passes: every automatic Task so far is a day older.
    const aDayPasses = () =>
      prisma.$executeRaw`UPDATE "tasks" SET "created_at" = "created_at" - interval '1 day'
        WHERE "kind" = ${PLACE_RESEARCH_KIND} AND "origin" = 'rule'`;
    // The next day, with no new Signal: the rows that waited, most Signals
    // first. The cap holds on that day too.
    await aDayPasses();
    expect((await topUp(3, 2)).map((t) => t.subjectId)).toEqual([bySignals(7), bySignals(6)]);
    expect(await topUp(3, 2)).toEqual([]);
    await aDayPasses();
    expect((await topUp(3, 2)).map((t) => t.subjectId)).toEqual([bySignals(5)]);
    expect(await topUp(3, 2)).toEqual([]);
    await aDayPasses();
    expect(await topUp(3, 2)).toEqual([]);
  });

  it("a Task that a Worker gives back while its row closes is cancelled all the same", async () => {
    // LEASED when the close starts, PENDING when it writes: one statement
    // covers both, so no claimable Task is left on a closed row.
    const row = await queued("Given back", 9);
    await topUp(3, 10);
    const task = await claim();
    await taskResolvers.Mutation.failTask(null, { id: task.id, leaseToken: task.leaseToken!, error: "try later" }, worker);
    expect((await tasksOf(row.id))[0]).toMatchObject({ status: "PENDING" });
    await resolveUnresolvedPlaceName(null, { id: row.id, resolution: { kind: "NOT_A_PLACE" } }, platform);
    expect((await tasksOf(row.id))[0]).toMatchObject({ status: "CANCELLED", cancelledById: PLATFORM_ID });
    expect(await claimTasks(null, { kind: PLACE_RESEARCH_KIND, limit: 5 }, worker)).toEqual([]);
  });

  it("two top-ups at once do not spend the cap twice", async () => {
    for (const n of [9, 8, 7, 6]) await queued(`Race ${n}`, n);
    const [a, b] = await Promise.all([topUp(3, 2), topUp(3, 2)]);
    expect(a.length + b.length).toBe(2);
    expect(await prisma.task.count({ where: { kind: PLACE_RESEARCH_KIND, origin: "rule" } })).toBe(2);
  });

  it("the rule never asks twice for one row, whatever became of its Task; a person can ask again", async () => {
    const failed = await queued("Failed", 9);
    const cancelled = await queued("Cancelled", 8);
    const [first, second] = await topUp(3, 10);
    await prisma.task.update({ where: { id: first!.id }, data: { status: "FAILED", lastError: "gave up" } });
    await prisma.task.update({ where: { id: second!.id }, data: { status: "CANCELLED" } });

    expect(await topUp(3, 10, 1)).toEqual([]);
    expect(await tasksOf(failed.id)).toHaveLength(1);
    expect(await tasksOf(cancelled.id)).toHaveLength(1);

    const again = await requestPlaceNameResearch(null, { id: failed.id }, platform);
    expect(again).toMatchObject({ status: "PENDING", origin: "user", requesterId: PLATFORM_ID });
    expect(await tasksOf(failed.id)).toHaveLength(2);
  });

  it("claimTasks tops the queue up first, with the configured threshold and cap", async () => {
    const row = await queued("Claimed", 5);
    const before = { min: env.PLACE_RESEARCH_AUTO_MIN_SIGNALS, cap: env.PLACE_RESEARCH_AUTO_DAILY_CAP };
    try {
      // Off: a claim creates nothing and finds nothing.
      env.PLACE_RESEARCH_AUTO_MIN_SIGNALS = undefined;
      expect(await claimTasks(null, { kind: PLACE_RESEARCH_KIND, limit: 1 }, worker)).toEqual([]);
      // A claim of another kind never runs the rule.
      env.PLACE_RESEARCH_AUTO_MIN_SIGNALS = 3;
      env.PLACE_RESEARCH_AUTO_DAILY_CAP = 10;
      await claimTasks(null, { kind: "event.impact_prior.web", limit: 1 }, worker);
      expect(await tasksOf(row.id)).toHaveLength(0);
      // On: the claim creates the Task and leases it in the same call.
      const [task] = await claimTasks(null, { kind: PLACE_RESEARCH_KIND, limit: 1 }, worker);
      expect(task).toMatchObject({ subjectId: row.id, origin: "rule", status: "LEASED", leaseOwnerId: WORKER_ID });
    } finally {
      env.PLACE_RESEARCH_AUTO_MIN_SIGNALS = before.min;
      env.PLACE_RESEARCH_AUTO_DAILY_CAP = before.cap;
    }
  });

  it("a resolve cancels a PENDING Task at once, also a Task that a person requested", async () => {
    const auto = await queued("Resolved auto", 9);
    const personal = await queued("Resolved personal", 1);
    await topUp(3, 10);
    await requestPlaceNameResearch(null, { id: personal.id }, platform);

    for (const row of [auto, personal]) {
      await resolveUnresolvedPlaceName(null, { id: row.id, resolution: { kind: "POINT", point: { lat: 61, lng: 70.5 } } }, platform);
      const [task] = await tasksOf(row.id);
      expect(task).toMatchObject({ status: "CANCELLED", cancelledById: PLATFORM_ID });
      expect(task!.cancelRequestedAt).toBeInstanceOf(Date);
    }
    // Nothing is left to claim.
    expect(await claimTasks(null, { kind: PLACE_RESEARCH_KIND, limit: 5 }, worker)).toEqual([]);
  });

  it("not a place flags a LEASED Task: the Worker sees it at its heartbeat, and its completion stores nothing", async () => {
    const heartbeat = await queued("Heartbeat", 9);
    await topUp(3, 10);
    const first = await claim();
    await resolveUnresolvedPlaceName(null, { id: heartbeat.id, resolution: { kind: "NOT_A_PLACE" } }, platform);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      status: "LEASED",
      cancelledById: PLATFORM_ID,
    });
    expect(await heartbeatTask(null, { id: first.id, leaseToken: first.leaseToken! }, worker)).toMatchObject({ status: "CANCELLED" });

    const completion = await queued("Completion", 9);
    await requestPlaceNameResearch(null, { id: completion.id }, platform);
    const second = await claim();
    await resolveUnresolvedPlaceName(null, { id: completion.id, resolution: { kind: "NOT_A_PLACE" } }, platform);
    const done = await completeTask(
      null,
      { id: second.id, leaseToken: second.leaseToken!, result: { raw: true }, place: FOUND, methodVersion: "m" },
      worker,
    );
    expect(done).toMatchObject({ status: "CANCELLED", result: null, outcome: null });
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: completion.id } })).toBe(0);
  });

  it("a new alias that closes the row cancels its Task", async () => {
    const row = await queued("Aliased", 9);
    await topUp(3, 10);
    await createPlaceAlias(
      null,
      { input: { name: "Aliased", countryCode: CC, scopeLocationId: STATE_ID, locationId: DISTRICT_ID } },
      platform,
    );
    expect(await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "resolved" });
    expect((await tasksOf(row.id))[0]).toMatchObject({ status: "CANCELLED", cancelledById: PLATFORM_ID });
  });

  it("an ambiguous row keeps its Task, and the Worker can complete it", async () => {
    const row = await queued("Kept", 9);
    await topUp(3, 10);
    await resolveUnresolvedPlaceName(null, { id: row.id, resolution: { kind: "AMBIGUOUS" } }, platform);
    expect((await tasksOf(row.id))[0]).toMatchObject({ status: "PENDING", cancelRequestedAt: null });
    const task = await claim();
    expect(await completeTask(null, { id: task.id, leaseToken: task.leaseToken!, result: {}, place: FOUND, methodVersion: "m" }, worker)).toMatchObject({
      status: "COMPLETED",
      outcome: "found",
    });
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: row.id } })).toBe(1);
  });

  it("a completion for a row that is closed with no cancel request is cancelled all the same", async () => {
    const row = await queued("Closed behind", 9);
    await topUp(3, 10);
    const task = await claim();
    // A row closed by a path that did not cancel (before this rule existed).
    await prisma.unresolvedPlaceNames.update({ where: { id: row.id }, data: { status: "resolved" } });
    const done = await completeTask(null, { id: task.id, leaseToken: task.leaseToken!, result: {}, place: FOUND, methodVersion: "m" }, worker);
    expect(done).toMatchObject({ status: "CANCELLED", outcome: null });
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: row.id } })).toBe(0);
  });
});
