/**
 * Place research against the real schema (ADR-0010 and ADR-0019 amendments,
 * decision D-0296, Exponential #1722): the request and its gate, the dedupe,
 * the daily cap, the payload, a valid completion for each outcome, the
 * country check, a lost lease, the read on the row, and a resolution that
 * uses a proposal.
 *
 * Self-seeding: a country with two states and a district, a second country,
 * a team scoped to one state, Signals and queue rows. All deleted in
 * afterAll, so it runs against an empty scratch database:
 * `bun run test:db tests/resolvers/placeResearch.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { unresolvedPlaceNameResolvers } from "../../src/resolvers/unresolvedPlaceName.resolver.js";
import { taskResolvers } from "../../src/resolvers/task.resolver.js";
import { PLACE_NAME_SUBJECT, PLACE_RESEARCH_KIND } from "../../src/utils/task-kinds.js";
import type { PlaceProposalInput } from "../../src/services/place-research.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { recordUnresolvedPlaceName, resolveUnresolvedPlaceName, requestPlaceNameResearch } =
  unresolvedPlaceNameResolvers.Mutation;
const { research } = unresolvedPlaceNameResolvers.UnresolvedPlaceName;
const { claimTasks, completeTask, failTask } = taskResolvers.Mutation;

const RUN = `pr-db-${Date.now()}`;
const CC = "ZW";
const COUNTRY_ID = `${RUN}-country`;
const COUNTRY_B_ID = `${RUN}-country-b`;
const STATE_A_ID = `${RUN}-state-a`;
const STATE_B_ID = `${RUN}-state-b`;
const DISTRICT_A1_ID = `${RUN}-district-a1`;
const ORG_ID = `${RUN}-org`;
const TEAM_ID = `${RUN}-team`;
const STATE_ADMIN_ID = `${RUN}-state-admin`;
const ANALYST_ID = `${RUN}-analyst`;
const PLATFORM_ID = `${RUN}-platform`;
/** A second platform admin: the cap test fills this requester's day. */
const CAPPED_ID = `${RUN}-capped`;
const WORKER_A = `${RUN}-worker-a`;
const WORKER_B = `${RUN}-worker-b`;
const USER_IDS = [STATE_ADMIN_ID, ANALYST_ID, PLATFORM_ID, CAPPED_ID, WORKER_A, WORKER_B];

const as = (id: string, role: string, authMethod = "session"): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod, locale: "en", signalScope: { kind: "full" } }) as unknown as Context;
const pipeline = as(`${RUN}-pipeline`, "pipeline", "api-key");
const platform = as(PLATFORM_ID, "admin");
const capped = as(CAPPED_ID, "admin");
const stateAdmin = as(STATE_ADMIN_ID, "member");
const analyst = as(ANALYST_ID, "member");
const workerA = as(WORKER_A, "worker", "api-key");
const workerB = as(WORKER_B, "worker", "api-key");

let sourceId: string | undefined;

async function insertArea(id: string, name: string, level: number, parentId: string | null, wkt: string) {
  const ancestors = parentId
    ? [parentId, ...(await prisma.locations.findUniqueOrThrow({ where: { id: parentId } })).ancestorIds]
    : [];
  await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
    VALUES (${id}, ${name}, ${level}, ${parentId}, ${ancestors}::text[], ST_GeomFromText(${wkt}, 4326))`;
}

let signalSeq = 0;
async function signalAt(locationId: string): Promise<string> {
  const signal = await prisma.signals.create({
    data: {
      sourceId: sourceId!,
      rawData: {},
      contentHash: `${RUN}-h${signalSeq}`,
      title: `Post ${signalSeq++}`,
      publishedAt: new Date("2026-11-20T00:00:00.000Z"),
      locationId,
      countries: { connect: [{ id: COUNTRY_ID }] },
    },
  });
  return signal.id;
}

/** A queue row with `signals` Signals; each is seen a minute after the last. */
async function queued(name: string, areaLocationId: string, signals = 1, nameAr?: string) {
  let row;
  const signalIds: string[] = [];
  for (let i = 0; i < signals; i++) {
    const signalId = await signalAt(areaLocationId);
    signalIds.push(signalId);
    row = await recordUnresolvedPlaceName(
      null,
      {
        input: {
          signalId,
          name,
          nameAr,
          countryCode: CC,
          areaLocationId,
          seenAt: new Date(Date.UTC(2026, 10, 20, 0, i)),
        },
      },
      pipeline,
    );
  }
  return { row: row!, signalIds };
}

const FOUND: PlaceProposalInput = {
  outcome: "found",
  latitude: 61,
  longitude: 70.5,
  nameFound: "Um Dabakir",
  confidence: "medium",
  reason: "Two news reports place the village 30 km south of Abu Karinka.",
  sources: [{ url: "https://example.org/report", quote: "Um Dabakir, south of Abu Karinka" }],
};

/** Claim place research Tasks, oldest first, until `id` is held; fail the rest back to the queue. */
async function claimOwn(id: string, worker: Context) {
  for (let i = 0; i < 50; i++) {
    const [task] = await claimTasks(null, { kind: PLACE_RESEARCH_KIND, limit: 1 }, worker);
    if (!task) break;
    if (task.id === id) return task;
    await prisma.task.update({ where: { id: task.id }, data: { status: "CANCELLED", leaseExpiresAt: null } });
  }
  throw new Error(`Task ${id} was not claimable`);
}

const complete = (worker: Context, task: { id: string; leaseToken: string | null }, place: PlaceProposalInput | null, extra: Record<string, unknown> = {}) =>
  completeTask(
    null,
    { id: task.id, leaseToken: task.leaseToken!, result: { raw: "audit" }, place, methodVersion: "clear-place-research@0.1.0", ...extra },
    worker,
  );

const code = (e: unknown) => (e as { extensions?: { code?: string } }).extensions?.code;
const subCode = (e: unknown) => (e as { extensions?: { subCode?: string } }).extensions?.subCode;
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describeIfDb("Place research against the real schema", () => {
  beforeAll(async () => {
    for (const id of USER_IDS) {
      const role = id === PLATFORM_ID || id === CAPPED_ID ? "admin" : id.includes("worker") ? "worker" : "member";
      await prisma.user.create({ data: { id, name: id, email: `${id}@example.test`, role } });
    }
    await prisma.organisations.create({ data: { id: ORG_ID, name: "PR DB Org", slug: ORG_ID } });
    await prisma.teams.create({ data: { id: TEAM_ID, organisationId: ORG_ID, name: "State A team", slug: TEAM_ID } });
    await prisma.teamMembers.createMany({
      data: [
        { teamId: TEAM_ID, userId: STATE_ADMIN_ID, role: "team_admin" },
        { teamId: TEAM_ID, userId: ANALYST_ID, role: "analyst" },
      ],
    });
    await insertArea(COUNTRY_ID, "Testland", 0, null, "MULTIPOLYGON(((70 60, 74 60, 74 64, 70 64, 70 60)))");
    await insertArea(STATE_A_ID, "State A", 1, COUNTRY_ID, "MULTIPOLYGON(((70 60, 72 60, 72 64, 70 64, 70 60)))");
    await insertArea(STATE_B_ID, "State B", 1, COUNTRY_ID, "MULTIPOLYGON(((72 60, 74 60, 74 64, 72 64, 72 60)))");
    await insertArea(DISTRICT_A1_ID, "Abu Karinka", 2, STATE_A_ID, "MULTIPOLYGON(((70 60, 71 60, 71 62, 70 62, 70 60)))");
    await insertArea(COUNTRY_B_ID, "Otherland", 0, null, "MULTIPOLYGON(((74 60, 78 60, 78 64, 74 64, 74 60)))");
    await prisma.teamLocations.create({ data: { teamId: TEAM_ID, locationId: STATE_A_ID } });
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
  });

  afterAll(async () => {
    const rows = await prisma.unresolvedPlaceNames.findMany({ where: { countryCode: CC }, select: { id: true } });
    const rowIds = rows.map((r) => r.id);
    await prisma.activityLogs.deleteMany({ where: { userId: { in: USER_IDS } } });
    await prisma.placeNameProposals.deleteMany({ where: { unresolvedPlaceNameId: { in: rowIds } } });
    await prisma.task.deleteMany({
      where: { OR: [{ subjectType: PLACE_NAME_SUBJECT, subjectId: { in: rowIds } }, { requesterId: CAPPED_ID }] },
    });
    await prisma.notifications.deleteMany({ where: { userId: { in: USER_IDS } } });
    await prisma.unresolvedPlaceNames.deleteMany({ where: { countryCode: CC } });
    await prisma.placeAliases.deleteMany({ where: { countryCode: CC } });
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.teamLocations.deleteMany({ where: { teamId: TEAM_ID } });
    await prisma.locations.deleteMany({ where: { level: 4, ancestorIds: { has: COUNTRY_ID } } });
    await prisma.locations.deleteMany({ where: { level: 2, ancestorIds: { has: COUNTRY_ID } } });
    await prisma.locations.deleteMany({ where: { level: 1, ancestorIds: { has: COUNTRY_ID } } });
    await prisma.locations.deleteMany({ where: { id: { in: [COUNTRY_ID, COUNTRY_B_ID] } } });
    await prisma.teamMembers.deleteMany({ where: { teamId: TEAM_ID } });
    await prisma.teams.deleteMany({ where: { id: TEAM_ID } });
    await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
    await prisma.organisations.deleteMany({ where: { id: ORG_ID } });
  });

  it("a request creates one Task whose payload carries the name, the state and the 10 newest Signals", async () => {
    const { row, signalIds } = await queued("Um Dabakir", STATE_A_ID, 12, "أم دباكر");
    const task = await requestPlaceNameResearch(null, { id: row.id }, platform);

    expect(task).toMatchObject({
      kind: PLACE_RESEARCH_KIND,
      subjectType: PLACE_NAME_SUBJECT,
      subjectId: row.id,
      status: "PENDING",
      origin: "user",
      requesterId: PLATFORM_ID,
      teamId: null,
    });
    expect(task.payload).toEqual({
      name: "Um Dabakir",
      nameAr: "أم دباكر",
      countryCode: CC,
      stateLocationId: STATE_A_ID,
      stateName: "State A",
      // Newest first: the last 10 of the 12 recorded.
      signalIds: signalIds.slice(2).reverse(),
    });

    expect(await research(row, null, platform)).toMatchObject({ task: { id: task.id, status: "PENDING" }, proposal: null });
  });

  it("the gate is the queue's: a team admin inside the area, a platform admin anywhere, nobody else", async () => {
    const inside = (await queued("Kamo", STATE_A_ID)).row;
    const outside = (await queued("Kamo", STATE_B_ID)).row;

    expect(code(await rejection(requestPlaceNameResearch(null, { id: inside.id }, analyst)))).toBe("FORBIDDEN");
    expect(code(await rejection(requestPlaceNameResearch(null, { id: inside.id }, workerA)))).toBe("FORBIDDEN");
    expect(code(await rejection(requestPlaceNameResearch(null, { id: inside.id }, pipeline)))).toBe("FORBIDDEN");
    expect(code(await rejection(requestPlaceNameResearch(null, { id: outside.id }, stateAdmin)))).toBe("FORBIDDEN");
    expect(await prisma.task.count({ where: { subjectId: { in: [inside.id, outside.id] } } })).toBe(0);

    expect(await requestPlaceNameResearch(null, { id: inside.id }, stateAdmin)).toMatchObject({ requesterId: STATE_ADMIN_ID });
    expect(await requestPlaceNameResearch(null, { id: outside.id }, platform)).toMatchObject({ requesterId: PLATFORM_ID });
    // One row by id, under the same rule.
    const { unresolvedPlaceName } = unresolvedPlaceNameResolvers.Query;
    expect(await unresolvedPlaceName(null, { id: inside.id }, stateAdmin)).toMatchObject({ id: inside.id, status: "open" });
    expect(await unresolvedPlaceName(null, { id: outside.id }, platform)).toMatchObject({ id: outside.id });
    expect(await unresolvedPlaceName(null, { id: "no-such-row" }, platform)).toBeNull();
    expect(code(await rejection(unresolvedPlaceName(null, { id: outside.id }, stateAdmin)))).toBe("FORBIDDEN");
    expect(code(await rejection(unresolvedPlaceName(null, { id: inside.id }, analyst)))).toBe("FORBIDDEN");
    expect(code(await rejection(unresolvedPlaceName(null, { id: inside.id }, workerA)))).toBe("FORBIDDEN");
    // The row's research is a decider's to read.
    expect(code(await rejection(research(inside, null, analyst)))).toBe("FORBIDDEN");
    expect(code(await rejection(research(inside, null, workerA)))).toBe("FORBIDDEN");
  });

  it("a second request while the Task is PENDING or LEASED returns it; concurrent requests create one", async () => {
    const { row } = await queued("Dedupe", STATE_A_ID);
    const [a, b, c] = await Promise.all([
      requestPlaceNameResearch(null, { id: row.id }, platform),
      requestPlaceNameResearch(null, { id: row.id }, platform),
      requestPlaceNameResearch(null, { id: row.id }, stateAdmin),
    ]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(await prisma.task.count({ where: { subjectId: row.id } })).toBe(1);

    const leased = await claimOwn(a.id, workerA);
    expect((await requestPlaceNameResearch(null, { id: row.id }, stateAdmin)).id).toBe(a.id);
    expect(await research(row, null, stateAdmin)).toMatchObject({ task: { id: a.id, status: "LEASED" } });

    // Once it completes, a new request opens a new Task.
    await complete(workerA, leased, { outcome: "not_found", reason: "No source names it." });
    const next = await requestPlaceNameResearch(null, { id: row.id }, platform);
    expect(next.id).not.toBe(a.id);
    expect(await prisma.task.count({ where: { subjectId: row.id } })).toBe(2);
  });

  it("a closed row is refused", async () => {
    const { row } = await queued("Closed", STATE_A_ID);
    await resolveUnresolvedPlaceName(null, { id: row.id, resolution: { kind: "NOT_A_PLACE" } }, platform);
    expect(code(await rejection(requestPlaceNameResearch(null, { id: row.id }, platform)))).toBe("CONFLICT");

    // An ambiguous row stays resolvable, so it can be researched.
    const { row: ambiguous } = await queued("Ambiguous", STATE_A_ID);
    await resolveUnresolvedPlaceName(null, { id: ambiguous.id, resolution: { kind: "AMBIGUOUS" } }, platform);
    expect(await requestPlaceNameResearch(null, { id: ambiguous.id }, platform)).toMatchObject({ status: "PENDING" });
  });

  it("the per-requester daily cap counts these requests", async () => {
    const { row } = await queued("Capped", STATE_A_ID);
    const cap = Number(process.env.TASK_REQUEST_DAILY_CAP ?? 20);
    await prisma.task.createMany({
      data: Array.from({ length: cap }, (_, i) => ({
        kind: "event.impact_prior.web",
        subjectType: "event",
        subjectId: `${RUN}-cap-${i}`,
        payload: {},
        requestId: `${RUN}-cap-${i}`,
        requesterId: CAPPED_ID,
        status: "CANCELLED" as const,
      })),
    });
    const e = await rejection(requestPlaceNameResearch(null, { id: row.id }, capped));
    expect(code(e)).toBe("FORBIDDEN");
    expect(subCode(e)).toBe("DAILY_CAP");
    expect(await prisma.task.count({ where: { subjectId: row.id } })).toBe(0);
  });

  it("found: one proposal row in the Task's transaction, read on the row; resolving with it records the decider", async () => {
    const { row, signalIds } = await queued("Um Dabaker", STATE_A_ID, 1);
    const requested = await requestPlaceNameResearch(null, { id: row.id }, stateAdmin);
    const leased = await claimOwn(requested.id, workerA);
    const notificationsBefore = await prisma.notifications.count();

    const done = await complete(workerA, leased, FOUND, {
      usage: { model: "claude-test", inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    });
    expect(done).toMatchObject({ status: "COMPLETED", outcome: "found", result: { raw: "audit" }, costUsd: 0.01 });

    const { task, proposal } = await research(row, null, stateAdmin);
    expect(task).toBeNull();
    expect(proposal).toMatchObject({
      unresolvedPlaceNameId: row.id,
      taskId: requested.id,
      outcome: "found",
      latitude: 61,
      longitude: 70.5,
      nameFound: "Um Dabakir",
      confidence: "medium",
      reason: FOUND.reason,
      sources: FOUND.sources,
      methodVersion: "clear-place-research@0.1.0",
      usedById: null,
      usedAt: null,
    });
    // Nobody is notified of a place research outcome.
    await new Promise((r) => setTimeout(r, 50));
    expect(await prisma.notifications.count()).toBe(notificationsBefore);

    // A point that is not the proposal's is refused with the proposal id;
    // so is another row's proposal, and an answer that is not a POINT.
    const args = (point: { lat: number; lng: number }) => ({
      id: row.id,
      resolution: { kind: "POINT" as const, point },
      proposalId: proposal!.id,
    });
    expect(code(await rejection(resolveUnresolvedPlaceName(null, args({ lat: 61.2, lng: 70.5 }), stateAdmin)))).toBe("BAD_USER_INPUT");
    expect(
      code(await rejection(resolveUnresolvedPlaceName(null, { id: row.id, resolution: { kind: "NOT_A_PLACE" }, proposalId: proposal!.id }, stateAdmin))),
    ).toBe("BAD_USER_INPUT");
    const other = (await queued("Other row", STATE_A_ID)).row;
    expect(
      code(await rejection(resolveUnresolvedPlaceName(null, { ...args({ lat: 61, lng: 70.5 }), id: other.id }, stateAdmin))),
    ).toBe("BAD_USER_INPUT");

    const resolved = await resolveUnresolvedPlaceName(null, args({ lat: 61, lng: 70.5 }), stateAdmin);
    expect(resolved).toMatchObject({ status: "resolved", resolvedById: STATE_ADMIN_ID });
    const used = await prisma.placeNameProposals.findUniqueOrThrow({ where: { id: proposal!.id } });
    expect(used.usedById).toBe(STATE_ADMIN_ID);
    expect(used.usedAt).toBeInstanceOf(Date);
    // The resolution is the existing path: an alias, and the Signal moved.
    const alias = await prisma.placeAliases.findUniqueOrThrow({ where: { id: resolved!.placeAliasId! } });
    expect((await prisma.signals.findUniqueOrThrow({ where: { id: signalIds[0] } })).locationId).toBe(alias.locationId);
  });

  it("not_found and not_a_place store a reason and no point; a newer proposal replaces the older in the read", async () => {
    const { row } = await queued("Nowhere", STATE_A_ID);
    const first = await claimOwn((await requestPlaceNameResearch(null, { id: row.id }, platform)).id, workerA);
    expect(await complete(workerA, first, { outcome: "not_found", reason: "No map or report names it." })).toMatchObject({
      status: "COMPLETED",
      outcome: "not_found",
    });
    expect((await research(row, null, platform)).proposal).toMatchObject({
      outcome: "not_found",
      latitude: null,
      longitude: null,
      nameFound: null,
      confidence: null,
      reason: "No map or report names it.",
      sources: [],
    });

    const second = await claimOwn((await requestPlaceNameResearch(null, { id: row.id }, platform)).id, workerA);
    await complete(workerA, second, {
      outcome: "not_a_place",
      reason: "It is the name of a militia.",
      sources: [{ url: "https://example.org/militia", quote: "the Nowhere brigade" }],
    });
    expect((await research(row, null, platform)).proposal).toMatchObject({ outcome: "not_a_place", taskId: second.id });
    // The older proposal stays as history.
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: row.id } })).toBe(2);
  });

  it("a point outside the row's country is refused: nothing is stored and the Task stays leased", async () => {
    const { row } = await queued("Across the border", STATE_A_ID);
    const leased = await claimOwn((await requestPlaceNameResearch(null, { id: row.id }, platform)).id, workerA);

    // In Otherland, and in no area at all.
    for (const point of [{ latitude: 61, longitude: 75 }, { latitude: 10, longitude: 10 }]) {
      const e = await rejection(complete(workerA, leased, { ...FOUND, ...point }));
      expect(code(e)).toBe("BAD_USER_INPUT");
      expect(subCode(e)).toBe("POINT_OUTSIDE_COUNTRY");
    }
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: row.id } })).toBe(0);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: leased.id } })).toMatchObject({
      status: "LEASED",
      leaseOwnerId: WORKER_A,
      result: null,
      outcome: null,
    });

    // The Worker corrects the point (anywhere in the country, also another
    // state), or fails the Task.
    expect(await complete(workerA, leased, { ...FOUND, latitude: 61, longitude: 72.5 })).toMatchObject({
      status: "COMPLETED",
      outcome: "found",
    });
    const again = await claimOwn((await requestPlaceNameResearch(null, { id: row.id }, platform)).id, workerA);
    expect(await failTask(null, { id: again.id, leaseToken: again.leaseToken!, error: "no point inside the country" }, workerA)).toMatchObject({
      status: "PENDING",
      lastError: "no point inside the country",
    });
    // A Task out of attempts is FAILED: the row shows it as its latest Task,
    // with no open Task, beside the proposal of the earlier run.
    await prisma.task.update({ where: { id: again.id }, data: { attempts: 3, maxAttempts: 3 } });
    const last = await claimOwn(again.id, workerA).catch(() => null);
    expect(last).toBeNull();
    await prisma.task.update({ where: { id: again.id }, data: { attempts: 2 } });
    const final = await claimOwn(again.id, workerA);
    await failTask(null, { id: final.id, leaseToken: final.leaseToken!, error: "gave up" }, workerA);
    expect(await research(row, null, platform)).toMatchObject({
      task: null,
      latestTask: { id: again.id, status: "FAILED", lastError: "gave up" },
      proposal: { outcome: "found" },
    });
    // The error is the requester's and platform admins' to read.
    expect((await research(row, null, stateAdmin)).latestTask).toMatchObject({ status: "FAILED", lastError: null });
  });

  it("the shape of a proposal is checked, and place is for this kind only", async () => {
    const { row } = await queued("Shapes", STATE_A_ID);
    const leased = await claimOwn((await requestPlaceNameResearch(null, { id: row.id }, platform)).id, workerA);
    const bad: Array<PlaceProposalInput | null> = [
      null, // a place research Task completes with a place
      { ...FOUND, sources: [] },
      { ...FOUND, sources: [{ url: "ftp://example.org/x", quote: "q" }] },
      { ...FOUND, sources: [{ url: "example.org/x", quote: "q" }] },
      { ...FOUND, sources: [{ url: "https://example.org/x", quote: " " }] },
      { ...FOUND, latitude: null },
      { ...FOUND, longitude: 181 },
      { ...FOUND, nameFound: "" },
      { ...FOUND, confidence: null },
      { ...FOUND, reason: " " },
      { outcome: "not_found", reason: "" },
      { outcome: "not_found", reason: "r", latitude: 61, longitude: 70.5 },
      { outcome: "not_a_place", reason: "r", confidence: "high" },
    ];
    for (const place of bad) {
      expect(code(await rejection(complete(workerA, leased, place)))).toBe("BAD_USER_INPUT");
    }
    // methodVersion is required with a place; cases are not for this kind.
    expect(code(await rejection(complete(workerA, leased, FOUND, { methodVersion: " " })))).toBe("BAD_USER_INPUT");
    expect(code(await rejection(complete(workerA, leased, null, { cases: [] })))).toBe("BAD_USER_INPUT");
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: row.id } })).toBe(0);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: leased.id } })).status).toBe("LEASED");
    await complete(workerA, leased, FOUND);

    // A Task of another kind refuses a place.
    const other = await prisma.task.create({
      data: {
        kind: "event.impact_prior.satellite",
        subjectType: "event",
        subjectId: `${RUN}-no-event`,
        payload: {},
        requestId: `${RUN}-other-kind`,
        status: "LEASED",
        leaseOwnerId: WORKER_A,
        leaseToken: "tok",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    try {
      expect(code(await rejection(complete(workerA, { id: other.id, leaseToken: "tok" }, FOUND)))).toBe("BAD_USER_INPUT");
    } finally {
      await prisma.task.delete({ where: { id: other.id } });
    }
  });

  it("a lost lease writes nothing: the old owner is locked out and the new owner completes", async () => {
    const { row } = await queued("Lost lease", STATE_A_ID);
    const requested = await requestPlaceNameResearch(null, { id: row.id }, platform);
    const stale = await claimOwn(requested.id, workerA);
    await prisma.task.update({ where: { id: requested.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const fresh = await claimOwn(requested.id, workerB);
    expect(fresh.leaseToken).not.toBe(stale.leaseToken);

    const e = await rejection(complete(workerA, stale, FOUND));
    expect(code(e)).toBe("FORBIDDEN");
    expect(subCode(e)).toBe("NOT_LEASE_OWNER");
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: row.id } })).toBe(0);

    expect(await complete(workerB, fresh, FOUND)).toMatchObject({ status: "COMPLETED", leaseOwnerId: WORKER_B });
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: row.id } })).toBe(1);
    // A second completion of the same Task writes no second row.
    expect(code(await rejection(complete(workerB, fresh, FOUND)))).toBe("CONFLICT");
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: row.id } })).toBe(1);
  });

  it("a cancel that landed while the Worker researched wins: no proposal", async () => {
    const { row } = await queued("Cancelled", STATE_A_ID);
    const requested = await requestPlaceNameResearch(null, { id: row.id }, platform);
    const leased = await claimOwn(requested.id, workerA);
    await taskResolvers.Mutation.cancelTask(null, { id: requested.id }, platform);
    expect(await complete(workerA, leased, FOUND)).toMatchObject({ status: "CANCELLED" });
    expect(await prisma.placeNameProposals.count({ where: { unresolvedPlaceNameId: row.id } })).toBe(0);
  });
});
