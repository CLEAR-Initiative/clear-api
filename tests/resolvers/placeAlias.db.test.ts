/**
 * The place alias API against the real schema (ADR-0019, Exponential #1310):
 * list, add by hand, change and delete; who may write which alias; a new
 * alias closing the open queue rows it answers; a deleted alias reopening
 * its row.
 *
 * Self-seeding: a country with two states and two districts, a team scoped
 * to one state, and Signals. All deleted in afterAll, so it runs against an
 * empty scratch database: `bun run test:db tests/resolvers/placeAlias.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { placeAliasResolvers } from "../../src/resolvers/placeAlias.resolver.js";
import { unresolvedPlaceNameResolvers } from "../../src/resolvers/unresolvedPlaceName.resolver.js";
import { gazetteerResolvers } from "../../src/resolvers/gazetteer.resolver.js";
import { normalizeGazetteerName } from "../../src/utils/geonames-normalize.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { createPlaceAlias, updatePlaceAlias, deletePlaceAlias } = placeAliasResolvers.Mutation;
const { placeAliases } = placeAliasResolvers.Query;
const { recordUnresolvedPlaceName, resolveUnresolvedPlaceName } = unresolvedPlaceNameResolvers.Mutation;

const RUN = `pa-db-${Date.now()}`;
const CC = "ZT";
const COUNTRY_ID = `${RUN}-country`;
const COUNTRY_B_ID = `${RUN}-country-b`;
const STATE_A_ID = `${RUN}-state-a`;
const STATE_B_ID = `${RUN}-state-b`;
const DISTRICT_A1_ID = `${RUN}-district-a1`;
const DISTRICT_A2_ID = `${RUN}-district-a2`;
const DISTRICT_B1_ID = `${RUN}-district-b1`;
const ORG_ID = `${RUN}-org`;
const TEAM_ID = `${RUN}-team`;
const STATE_ADMIN_ID = `${RUN}-state-admin`;
const ANALYST_ID = `${RUN}-analyst`;
const PLATFORM_ID = `${RUN}-platform`;
const USER_IDS = [STATE_ADMIN_ID, ANALYST_ID, PLATFORM_ID];

const as = (id: string, role: string, authMethod = "session"): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod, locale: "en", signalScope: { kind: "full" } }) as unknown as Context;
const pipeline = as(`${RUN}-pipeline`, "pipeline", "api-key");
const platform = as(PLATFORM_ID, "admin");
const stateAdmin = as(STATE_ADMIN_ID, "member");
const analyst = as(ANALYST_ID, "member");

let sourceId: string | undefined;
let signalSeq = 0;

async function insertArea(id: string, name: string, level: number, parentId: string | null, wkt: string) {
  const ancestors = parentId
    ? [parentId, ...(await prisma.locations.findUniqueOrThrow({ where: { id: parentId } })).ancestorIds]
    : [];
  await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
    VALUES (${id}, ${name}, ${level}, ${parentId}, ${ancestors}::text[], ST_GeomFromText(${wkt}, 4326))`;
}

async function signalAt(locationId: string): Promise<string> {
  const signal = await prisma.signals.create({
    data: {
      sourceId: sourceId!,
      rawData: {},
      contentHash: `h${signalSeq}`,
      title: `Post ${signalSeq++}`,
      publishedAt: new Date("2026-10-20T00:00:00.000Z"),
      locationId,
      countries: { connect: [{ id: COUNTRY_ID }] },
    },
  });
  return signal.id;
}

async function queued(name: string, areaLocationId: string, signalId: string) {
  return (await recordUnresolvedPlaceName(null, { input: { signalId, name, countryCode: CC, areaLocationId } }, pipeline))!;
}

const create = (context: Context, input: Partial<Parameters<typeof createPlaceAlias>[1]["input"]> & { name: string }) =>
  createPlaceAlias(null, { input: { countryCode: CC, scopeLocationId: STATE_A_ID, locationId: DISTRICT_A1_ID, ...input } }, context);

const list = (context: Context, args: Parameters<typeof placeAliases>[1] = {}) =>
  placeAliases(null, { countryCode: CC, ...args }, context);

const gazetteer = (name: string, withinLocationId?: string) =>
  gazetteerResolvers.Query.resolveGazetteerLocation(undefined, { name, countryCode: CC, withinLocationId }, pipeline);

const locationOf = async (signalId: string) =>
  (await prisma.signals.findUniqueOrThrow({ where: { id: signalId } })).locationId;

describeIfDb("The place alias API against the real schema", () => {
  beforeAll(async () => {
    for (const id of USER_IDS) {
      await prisma.user.create({
        data: { id, name: id === STATE_ADMIN_ID ? "Amal" : id, email: `${id}@example.test`, role: id === PLATFORM_ID ? "admin" : "member" },
      });
    }
    await prisma.organisations.create({ data: { id: ORG_ID, name: "PA DB Org", slug: ORG_ID } });
    await prisma.teams.create({ data: { id: TEAM_ID, organisationId: ORG_ID, name: "State A team", slug: TEAM_ID } });
    await prisma.teamMembers.createMany({
      data: [
        { teamId: TEAM_ID, userId: STATE_ADMIN_ID, role: "team_admin" },
        { teamId: TEAM_ID, userId: ANALYST_ID, role: "analyst" },
      ],
    });
    await insertArea(COUNTRY_ID, "Testland", 0, null, "MULTIPOLYGON(((80 60, 84 60, 84 64, 80 64, 80 60)))");
    await insertArea(STATE_A_ID, "State A", 1, COUNTRY_ID, "MULTIPOLYGON(((80 60, 82 60, 82 64, 80 64, 80 60)))");
    await insertArea(STATE_B_ID, "State B", 1, COUNTRY_ID, "MULTIPOLYGON(((82 60, 84 60, 84 64, 82 64, 82 60)))");
    await insertArea(DISTRICT_A1_ID, "Abu Karinka", 2, STATE_A_ID, "MULTIPOLYGON(((80 60, 81 60, 81 62, 80 62, 80 60)))");
    await insertArea(DISTRICT_A2_ID, "District A2", 2, STATE_A_ID, "MULTIPOLYGON(((81 60, 82 60, 82 62, 81 62, 81 60)))");
    await insertArea(DISTRICT_B1_ID, "District B1", 2, STATE_B_ID, "MULTIPOLYGON(((82 60, 83 60, 83 62, 82 62, 82 60)))");
    await insertArea(COUNTRY_B_ID, "Otherland", 0, null, "MULTIPOLYGON(((84 60, 88 60, 88 64, 84 64, 84 60)))");
    await prisma.teamLocations.create({ data: { teamId: TEAM_ID, locationId: STATE_A_ID } });
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
  });

  afterAll(async () => {
    await prisma.activityLogs.deleteMany({ where: { userId: { in: USER_IDS } } });
    await prisma.unresolvedPlaceNames.deleteMany({ where: { countryCode: CC } });
    await prisma.placeAliases.deleteMany({ where: { countryCode: CC } });
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.teamLocations.deleteMany({ where: { teamId: TEAM_ID } });
    for (const level of [4, 2, 1]) {
      await prisma.locations.deleteMany({ where: { level, ancestorIds: { has: COUNTRY_ID } } });
    }
    await prisma.locations.deleteMany({ where: { id: { in: [COUNTRY_ID, COUNTRY_B_ID] } } });
    await prisma.teamMembers.deleteMany({ where: { teamId: TEAM_ID } });
    await prisma.teams.deleteMany({ where: { id: TEAM_ID } });
    await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
    await prisma.organisations.deleteMany({ where: { id: ORG_ID } });
  });

  it("a team admin adds an alias in their state, with its Arabic spelling, and the gazetteer uses both", async () => {
    const alias = await create(stateAdmin, { name: "Um-Dabākir", nameAr: "أم دباكر", note: " Power station " });
    expect(alias).toMatchObject({
      nameNorm: "um dabakir",
      nameDisplay: "Um-Dabākir",
      countryCode: CC,
      scopeLocationId: STATE_A_ID,
      locationId: DISTRICT_A1_ID,
      source: "manual",
      createdById: STATE_ADMIN_ID,
      note: "Power station",
      canEdit: true,
    });
    expect(await gazetteer("Um Dabakir", STATE_A_ID)).toMatchObject({ source: "ALIAS", locationId: DISTRICT_A1_ID });
    expect(await gazetteer("أم دباكر", DISTRICT_A2_ID)).toMatchObject({ source: "ALIAS", locationId: DISTRICT_A1_ID });
    expect(await gazetteer("Um Dabakir", STATE_B_ID)).toBeNull();
    await expect
      .poll(() => prisma.activityLogs.findFirst({ where: { userId: STATE_ADMIN_ID, action: "place_alias.create", resourceId: alias.id } }))
      .toMatchObject({ resourceType: "place_alias" });
  });

  it("refuses the same spelling twice in one scope; another scope is another alias", async () => {
    await expect(create(stateAdmin, { name: "um dabakir" })).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    const inB = await create(platform, { name: "Um Dabakir", scopeLocationId: STATE_B_ID, locationId: DISTRICT_B1_ID });
    expect(inB).toMatchObject({ scopeLocationId: STATE_B_ID, locationId: DISTRICT_B1_ID });
  });

  it("keeps a team admin to their state: no other state, no country-wide alias, no target outside it", async () => {
    const forbidden = { extensions: { code: "FORBIDDEN" } };
    await expect(create(stateAdmin, { name: "Kamo", scopeLocationId: STATE_B_ID, locationId: DISTRICT_B1_ID })).rejects.toMatchObject(forbidden);
    await expect(create(stateAdmin, { name: "Kamo", scopeLocationId: null })).rejects.toMatchObject(forbidden);
    await expect(create(stateAdmin, { name: "Kamo", locationId: DISTRICT_B1_ID })).rejects.toMatchObject(forbidden);
    for (const context of [analyst, pipeline]) {
      await expect(create(context, { name: "Kamo" })).rejects.toMatchObject(forbidden);
    }
    expect(await prisma.placeAliases.count({ where: { countryCode: CC, nameNorm: "kamo" } })).toBe(0);
  });

  it("a platform admin adds a country-wide alias, and may put a target anywhere in the country", async () => {
    const dam = await create(platform, { name: "Merowe Dam", scopeLocationId: null, locationId: DISTRICT_B1_ID });
    expect(dam).toMatchObject({ scopeLocationId: null, locationId: DISTRICT_B1_ID, source: "manual" });
    expect(await gazetteer("Merowe Dam")).toMatchObject({ source: "ALIAS", locationId: DISTRICT_B1_ID });
    // A target in state B for an alias scoped to state A.
    const crossing = await create(platform, { name: "River crossing", locationId: DISTRICT_B1_ID });
    expect(crossing).toMatchObject({ scopeLocationId: STATE_A_ID, locationId: DISTRICT_B1_ID });
  });

  it("refuses a bad scope, target or name", async () => {
    const bad = { extensions: { code: "BAD_USER_INPUT" } };
    await expect(create(platform, { name: "Kamo", scopeLocationId: DISTRICT_A1_ID })).rejects.toMatchObject(bad);
    await expect(create(platform, { name: "Kamo", scopeLocationId: "no-such-location" })).rejects.toMatchObject(bad);
    await expect(create(platform, { name: "Kamo", locationId: COUNTRY_ID })).rejects.toMatchObject(bad);
    await expect(create(platform, { name: "Kamo", locationId: "no-such-location" })).rejects.toMatchObject(bad);
    await expect(create(platform, { name: "Kamo", locationId: null })).rejects.toMatchObject(bad);
    await expect(create(platform, { name: "Kamo", point: { lat: 61, lng: 80.5 } })).rejects.toMatchObject(bad);
    await expect(create(platform, { name: "Kamo", locationId: null, point: { lat: 10, lng: 10 } })).rejects.toMatchObject(bad);
    await expect(create(platform, { name: " -- " })).rejects.toMatchObject(bad);
    await expect(create(platform, { name: "Kamo", countryCode: "ZTT" })).rejects.toMatchObject(bad);
  });

  it("a point target becomes a landmark named after the spelling", async () => {
    const alias = await create(stateAdmin, { name: "Aruri", locationId: null, point: { lat: 61.2, lng: 81.4 } });
    const target = await prisma.locations.findUniqueOrThrow({ where: { id: alias.locationId } });
    expect(target).toMatchObject({ name: "Aruri", level: 4, parentId: DISTRICT_A2_ID, pointType: "landmark-geocoded" });
    // A team admin's point must fall in the scope.
    await expect(
      create(stateAdmin, { name: "Aruri East", locationId: null, point: { lat: 61, lng: 82.5 } }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("a new alias closes the open queue rows it answers and moves their signals", async () => {
    const waiting = await signalAt(STATE_A_ID);
    const inOtherState = await signalAt(STATE_B_ID);
    const rowA = await queued("Mazbud", STATE_A_ID, waiting);
    const rowB = await queued("Mazbud", STATE_B_ID, inOtherState);

    const alias = await create(stateAdmin, { name: "Mazbud", locationId: DISTRICT_A2_ID });
    expect(await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: rowA.id } })).toMatchObject({
      status: "resolved",
      placeAliasId: alias.id,
      resolvedById: STATE_ADMIN_ID,
    });
    expect(await locationOf(waiting)).toBe(DISTRICT_A2_ID);
    // The row in the other state is another name: it stays open.
    expect((await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: rowB.id } })).status).toBe("open");
    expect(await locationOf(inOtherState)).toBe(STATE_B_ID);
    await expect
      .poll(() => prisma.activityLogs.findFirst({ where: { action: "place_alias.create", resourceId: alias.id } }))
      .toMatchObject({ metadata: expect.objectContaining({ rowsResolved: 1, signalsMoved: 1 }) });
  });

  it("every decider reads the whole list; canEdit says what they may change", async () => {
    const all = await list(platform);
    expect(all.totalCount).toBeGreaterThanOrEqual(6);
    expect(all.items.every((a) => a.canEdit)).toBe(true);
    // Newest first.
    expect(all.items[0]).toMatchObject({ nameNorm: "mazbud" });

    const mine = await list(stateAdmin);
    expect(mine.totalCount).toBe(all.totalCount);
    for (const alias of mine.items) expect(alias.canEdit).toBe(alias.scopeLocationId === STATE_A_ID);
    expect(mine.items.some((a) => a.scopeLocationId === null)).toBe(true);

    for (const context of [analyst, pipeline]) {
      await expect(list(context)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
  });

  it("searches by spelling, Arabic spelling and target name, and filters by scope and source", async () => {
    const names = async (args: Parameters<typeof placeAliases>[1]) => (await list(platform, args)).items.map((a) => a.nameNorm);
    expect(await names({ search: "Um-Dabakir" })).toEqual(expect.arrayContaining(["um dabakir"]));
    expect(await names({ search: "دباكر" })).toEqual([normalizeGazetteerName("أم دباكر")]);
    // By the target's name: every alias that points at the district "Abu Karinka".
    expect((await list(platform, { search: "karinka" })).items.every((a) => a.locationId === DISTRICT_A1_ID)).toBe(true);
    expect(await names({ search: "no such place" })).toEqual([]);

    expect((await list(platform, { scopeLocationId: STATE_B_ID })).items.map((a) => a.nameNorm)).toEqual(["um dabakir"]);
    expect((await list(platform, { source: "review" })).totalCount).toBe(0);
    expect((await list(platform, { source: "manual" })).totalCount).toBe((await list(platform)).totalCount);
    expect((await placeAliases(null, { countryCode: "ZS" }, platform)).totalCount).toBe(0);
    await expect(list(platform, { source: "guess" })).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("pages with a cursor", async () => {
    const whole = (await list(platform, { first: 200 })).items.map((a) => a.id);
    const first = await list(platform, { first: 2 });
    expect(first).toMatchObject({ hasMore: true, endCursor: whole[1] });
    const second = await list(platform, { first: 2, after: first.endCursor });
    expect(second.items.map((a) => a.id)).toEqual(whole.slice(2, 4));
    const rest = await list(platform, { first: 200, after: second.endCursor });
    expect(rest).toMatchObject({ hasMore: false, endCursor: null });
    expect([...first.items, ...second.items, ...rest.items].map((a) => a.id)).toEqual(whole);
    for (const args of [{ first: 0 }, { first: 201 }, { after: "no-such-alias" }]) {
      await expect(list(platform, args)).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    }
  });

  it("changes the target, the note and the scope, each under its rule", async () => {
    const alias = await create(stateAdmin, { name: "Tabit" });
    const retargeted = await updatePlaceAlias(null, { id: alias.id, input: { locationId: DISTRICT_A2_ID } }, stateAdmin);
    expect(retargeted).toMatchObject({ locationId: DISTRICT_A2_ID, scopeLocationId: STATE_A_ID, note: null, canEdit: true });
    expect(await gazetteer("Tabit", STATE_A_ID)).toMatchObject({ locationId: DISTRICT_A2_ID });

    const noted = await updatePlaceAlias(null, { id: alias.id, input: { note: "Checked with the team" } }, stateAdmin);
    expect(noted).toMatchObject({ note: "Checked with the team", locationId: DISTRICT_A2_ID });

    // A team admin cannot widen it to the country, or move the target out of the state.
    const forbidden = { extensions: { code: "FORBIDDEN" } };
    await expect(updatePlaceAlias(null, { id: alias.id, input: { scopeLocationId: null } }, stateAdmin)).rejects.toMatchObject(forbidden);
    await expect(updatePlaceAlias(null, { id: alias.id, input: { locationId: DISTRICT_B1_ID } }, stateAdmin)).rejects.toMatchObject(forbidden);
    // A platform admin can.
    const wide = await updatePlaceAlias(null, { id: alias.id, input: { scopeLocationId: null } }, platform);
    expect(wide).toMatchObject({ scopeLocationId: null, locationId: DISTRICT_A2_ID });
    expect(await gazetteer("Tabit")).toMatchObject({ source: "ALIAS", locationId: DISTRICT_A2_ID });
    // Now country-wide: the team admin can no longer change it.
    await expect(updatePlaceAlias(null, { id: alias.id, input: { note: "x" } }, stateAdmin)).rejects.toMatchObject(forbidden);

    await expect(updatePlaceAlias(null, { id: alias.id, input: {} }, platform)).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(updatePlaceAlias(null, { id: "no-such-alias", input: { note: "x" } }, platform)).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    await expect
      .poll(() => prisma.activityLogs.count({ where: { action: "place_alias.update", resourceId: alias.id } }))
      .toBe(3);
  });

  it("a scope change that meets another alias of the spelling is a conflict", async () => {
    // "um dabakir" exists in state A and in state B.
    const inB = await prisma.placeAliases.findFirstOrThrow({ where: { countryCode: CC, nameNorm: "um dabakir", scopeLocationId: STATE_B_ID } });
    await expect(
      updatePlaceAlias(null, { id: inB.id, input: { scopeLocationId: STATE_A_ID, locationId: DISTRICT_A1_ID } }, platform),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });

  it("deleting an alias reopens its queue row and leaves the moved signals where they are", async () => {
    const waiting = await signalAt(STATE_A_ID);
    const row = await queued("Shangil", STATE_A_ID, waiting);
    const resolved = await resolveUnresolvedPlaceName(
      null,
      { id: row.id, resolution: { kind: "LOCATION", locationId: DISTRICT_A1_ID }, note: "Known" },
      stateAdmin,
    );
    expect(await locationOf(waiting)).toBe(DISTRICT_A1_ID);
    const aliasId = resolved!.placeAliasId!;

    await expect(deletePlaceAlias(null, { id: aliasId }, analyst)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(await deletePlaceAlias(null, { id: aliasId }, stateAdmin)).toBe(true);

    expect(await prisma.placeAliases.findUnique({ where: { id: aliasId } })).toBeNull();
    expect(await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "open",
      placeAliasId: null,
      resolvedById: null,
      resolvedAt: null,
      resolutionNote: null,
    });
    // The signal is not moved back, and the gazetteer no longer answers.
    expect(await locationOf(waiting)).toBe(DISTRICT_A1_ID);
    expect(await gazetteer("Shangil", STATE_A_ID)).toBeNull();
    // The reopened row can be answered again.
    expect(
      await resolveUnresolvedPlaceName(null, { id: row.id, resolution: { kind: "NOT_A_PLACE" } }, stateAdmin),
    ).toMatchObject({ status: "not_a_place" });
    await expect
      .poll(() => prisma.activityLogs.findFirst({ where: { action: "place_alias.delete", resourceId: aliasId } }))
      .toMatchObject({ metadata: expect.objectContaining({ nameNorm: "shangil", rowsReopened: 1 }) });
  });

  it("a team admin cannot delete an alias of another state or a country-wide one", async () => {
    const inB = await prisma.placeAliases.findFirstOrThrow({ where: { countryCode: CC, scopeLocationId: STATE_B_ID } });
    const wide = await prisma.placeAliases.findFirstOrThrow({ where: { countryCode: CC, scopeLocationId: null } });
    for (const id of [inB.id, wide.id]) {
      await expect(deletePlaceAlias(null, { id }, stateAdmin)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
    await expect(deletePlaceAlias(null, { id: "no-such-alias" }, platform)).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(await deletePlaceAlias(null, { id: wide.id }, platform)).toBe(true);
  });

  it("tells a decider reading a queue row's alias whether they may change it", async () => {
    const canEdit = unresolvedPlaceNameResolvers.PlaceAlias.canEdit;
    expect(await canEdit({ scopeLocationId: STATE_A_ID }, null, stateAdmin)).toBe(true);
    expect(await canEdit({ scopeLocationId: STATE_B_ID }, null, stateAdmin)).toBe(false);
    expect(await canEdit({ scopeLocationId: null }, null, stateAdmin)).toBe(false);
    expect(await canEdit({ scopeLocationId: null }, null, platform)).toBe(true);
    expect(await canEdit({ scopeLocationId: STATE_A_ID }, null, analyst)).toBe(false);
    expect(await canEdit({ scopeLocationId: STATE_B_ID, canEdit: true }, null, analyst)).toBe(true);
  });
});
