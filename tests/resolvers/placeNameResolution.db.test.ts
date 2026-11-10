/**
 * Resolving an unresolved place name against the real schema (ADR-0019,
 * Exponential #1309): each resolution kind, the alias it writes, the rule
 * that moves the waiting Signals, a concurrent double resolve, the alias
 * tier of `resolveGazetteerLocation`, and `placeNameSuggestions`.
 *
 * Self-seeding: a country with two states and two districts, GeoNames rows
 * under an unused country code, a team scoped to one state, and Signals. All
 * deleted in afterAll, so it runs against an empty scratch database:
 * `bun run test:db tests/resolvers/placeNameResolution.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { unresolvedPlaceNameResolvers } from "../../src/resolvers/unresolvedPlaceName.resolver.js";
import { gazetteerResolvers } from "../../src/resolvers/gazetteer.resolver.js";
import { normalizeGazetteerName } from "../../src/utils/geonames-normalize.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { recordUnresolvedPlaceName, resolveUnresolvedPlaceName } = unresolvedPlaceNameResolvers.Mutation;
const { placeNameSuggestions } = unresolvedPlaceNameResolvers.Query;
const { resolveGazetteerLocation } = gazetteerResolvers.Query;

const RUN = `pnr-db-${Date.now()}`;
const CC = "ZV";
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

/** GeoNames ids, far from any real one. */
const GN_UM_DABAKIR_A = 990130901; // inside district A1 (state A)
const GN_UM_DABAKIR_B = 990130902; // inside district B1 (state B), more populous
const GN_KAMO = 990130903; // state A, district A2
const GN_OTHER_COUNTRY = 990130904;

const as = (id: string, role: string, authMethod = "session"): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod, locale: "en", signalScope: { kind: "full" } }) as unknown as Context;
const pipeline = as(`${RUN}-pipeline`, "pipeline", "api-key");
const platform = as(PLATFORM_ID, "admin");
const stateAdmin = as(STATE_ADMIN_ID, "member");
const analyst = as(ANALYST_ID, "member");

let sourceId: string | undefined;

async function insertArea(id: string, name: string, level: number, parentId: string | null, wkt: string) {
  const ancestors = parentId
    ? [parentId, ...(await prisma.locations.findUniqueOrThrow({ where: { id: parentId } })).ancestorIds]
    : [];
  await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
    VALUES (${id}, ${name}, ${level}, ${parentId}, ${ancestors}::text[], ST_GeomFromText(${wkt}, 4326))`;
}

async function insertGeoname(geonamesId: number, name: string, lat: number, lng: number, names: string[], pop = 0n, cc = CC) {
  await prisma.geonames.create({
    data: { geonamesId, name, latitude: lat, longitude: lng, featureClass: "P", featureCode: "PPL", countryCode: cc, population: pop },
  });
  await prisma.geonamesName.createMany({
    data: [...new Set([name, ...names].map(normalizeGazetteerName))].map((nameNorm) => ({ geonamesId, nameNorm, countryCode: cc })),
  });
}

let signalSeq = 0;
async function signalAt(locationId: string, extra: { locationCorrectedAt?: Date } = {}): Promise<string> {
  const signal = await prisma.signals.create({
    data: {
      sourceId: sourceId!,
      rawData: {},
      contentHash: `h${signalSeq}`,
      title: `Post ${signalSeq++}`,
      publishedAt: new Date("2026-10-20T00:00:00.000Z"),
      locationId,
      countries: { connect: [{ id: COUNTRY_ID }] },
      ...extra,
    },
  });
  return signal.id;
}

/** Record a miss for each Signal; returns the queue row. */
async function queued(name: string, areaLocationId: string, signals: string[], nameAr?: string) {
  let row;
  for (const signalId of signals) {
    row = await recordUnresolvedPlaceName(
      null,
      { input: { signalId, name, nameAr, countryCode: CC, areaLocationId } },
      pipeline,
    );
  }
  return row!;
}

const resolve = (context: Context, id: string, resolution: Parameters<typeof resolveUnresolvedPlaceName>[1]["resolution"], note?: string) =>
  resolveUnresolvedPlaceName(null, { id, resolution, note }, context);

const gazetteer = (name: string, withinLocationId?: string) =>
  resolveGazetteerLocation(undefined, { name, countryCode: CC, withinLocationId }, pipeline);

const locationOf = async (signalId: string) =>
  (await prisma.signals.findUniqueOrThrow({ where: { id: signalId } })).locationId;

describeIfDb("Resolving an unresolved place name against the real schema", () => {
  beforeAll(async () => {
    for (const id of USER_IDS) {
      await prisma.user.create({
        data: { id, name: id, email: `${id}@example.test`, role: id === PLATFORM_ID ? "admin" : "member" },
      });
    }
    await prisma.organisations.create({ data: { id: ORG_ID, name: "PNR DB Org", slug: ORG_ID } });
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
    await insertArea(DISTRICT_A2_ID, "District A2", 2, STATE_A_ID, "MULTIPOLYGON(((71 60, 72 60, 72 62, 71 62, 71 60)))");
    await insertArea(DISTRICT_B1_ID, "District B1", 2, STATE_B_ID, "MULTIPOLYGON(((72 60, 73 60, 73 62, 72 62, 72 60)))");
    await insertArea(COUNTRY_B_ID, "Otherland", 0, null, "MULTIPOLYGON(((74 60, 78 60, 78 64, 74 64, 74 60)))");
    await prisma.teamLocations.create({ data: { teamId: TEAM_ID, locationId: STATE_A_ID } });

    await insertGeoname(GN_UM_DABAKIR_A, "Um Dabakir", 61, 70.5, ["أم دباكر"]);
    await insertGeoname(GN_UM_DABAKIR_B, "Um Dabakir", 61, 72.5, ["أم دباكر"], 5000n);
    await insertGeoname(GN_KAMO, "Kamo", 61, 71.5, ["Kamu"]);
    await insertGeoname(GN_OTHER_COUNTRY, "Elsewhere", 61, 75, [], 0n, "ZU");

    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
  });

  afterAll(async () => {
    await prisma.activityLogs.deleteMany({ where: { userId: { in: USER_IDS } } });
    await prisma.unresolvedPlaceNames.deleteMany({ where: { countryCode: CC } });
    await prisma.placeAliases.deleteMany({ where: { countryCode: CC } });
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.geonames.deleteMany({ where: { countryCode: { in: [CC, "ZU"] } } });
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

  it("before any alias, the gazetteer answers from GeoNames", async () => {
    expect(await gazetteer("Um Dabakir")).toMatchObject({ source: "GEONAMES", locationId: null, longitude: 72.5 });
  });

  it("a GeoNames answer becomes a landmark and an alias, and the waiting Signals move", async () => {
    const waiting = await signalAt(STATE_A_ID);
    const corrected = await signalAt(STATE_A_ID, { locationCorrectedAt: new Date("2026-10-21T00:00:00.000Z") });
    const elsewhere = await signalAt(DISTRICT_A2_ID);
    const row = await queued("Um Dabakir", STATE_A_ID, [waiting, corrected, elsewhere], "أم دباكر");

    const resolved = await resolve(stateAdmin, row.id, { kind: "GEONAMES", geonamesId: GN_UM_DABAKIR_A }, "Checked on the map");
    expect(resolved).toMatchObject({ status: "resolved", resolvedById: STATE_ADMIN_ID, resolutionNote: "Checked on the map" });
    expect(resolved!.resolvedAt).toBeInstanceOf(Date);

    const alias = await prisma.placeAliases.findUniqueOrThrow({
      where: { id: resolved!.placeAliasId! },
      include: { location: true },
    });
    expect(alias).toMatchObject({
      nameNorm: "um dabakir",
      nameDisplay: "Um Dabakir",
      countryCode: CC,
      scopeLocationId: STATE_A_ID,
      source: "review",
      createdById: STATE_ADMIN_ID,
    });
    expect(alias.location).toMatchObject({ name: "Um Dabakir", level: 4, parentId: DISTRICT_A1_ID, pointType: "landmark-geocoded" });
    // The Arabic spelling is aliased to the same place.
    expect(
      await prisma.placeAliases.findFirst({ where: { countryCode: CC, nameNorm: normalizeGazetteerName("أم دباكر") } }),
    ).toMatchObject({ locationId: alias.locationId, scopeLocationId: STATE_A_ID, nameDisplay: "أم دباكر" });

    // The waiting Signal moves. A corrected one stays: a human correction
    // always wins. One whose location does not hold the place stays too.
    const moved = await prisma.signals.findUniqueOrThrow({ where: { id: waiting }, include: { countries: { select: { id: true } } } });
    expect(moved).toMatchObject({ locationId: alias.locationId, locationCorrectedAt: null, pipelineLocationId: null });
    expect(moved.countries).toEqual([{ id: COUNTRY_ID }]);
    expect(await locationOf(corrected)).toBe(STATE_A_ID);
    expect(await locationOf(elsewhere)).toBe(DISTRICT_A2_ID);

    const links = await prisma.unresolvedPlaceNameSignals.findMany({ where: { unresolvedPlaceNameId: row.id } });
    expect(links.find((l) => l.signalId === waiting)!.relocatedAt).toBeInstanceOf(Date);
    expect(links.filter((l) => l.relocatedAt === null).map((l) => l.signalId).sort()).toEqual([corrected, elsewhere].sort());
    expect(await unresolvedPlaceNameResolvers.UnresolvedPlaceName.signalsMoved(row, null, platform)).toBe(1);

    await expect
      .poll(() => prisma.activityLogs.findFirst({ where: { userId: STATE_ADMIN_ID, action: "place_name.resolve", resourceId: row.id } }))
      .toMatchObject({ resourceType: "place_name", metadata: expect.objectContaining({ kind: "GEONAMES", signalsMoved: 1 }) });
  });

  it("the gazetteer checks aliases first, inside the alias scope only", async () => {
    const alias = await prisma.placeAliases.findFirstOrThrow({ where: { countryCode: CC, nameNorm: "um dabakir" } });
    // In the scope (the state, or a district inside it): the alias, as a CLEAR location.
    for (const within of [STATE_A_ID, DISTRICT_A1_ID, DISTRICT_A2_ID]) {
      expect(await gazetteer("Um-Dabākir", within)).toMatchObject({
        source: "ALIAS",
        locationId: alias.locationId,
        name: "Um Dabakir",
        latitude: 61,
        longitude: 70.5,
        countryCode: CC,
        exact: true,
        score: 1,
      });
    }
    expect(await gazetteer("أم دباكر", STATE_A_ID)).toMatchObject({ source: "ALIAS", locationId: alias.locationId });
    // Outside the scope, and with no area: GeoNames, as before.
    expect(await gazetteer("Um Dabakir", STATE_B_ID)).toMatchObject({ source: "GEONAMES", longitude: 72.5 });
    expect(await gazetteer("Um Dabakir")).toMatchObject({ source: "GEONAMES", locationId: null });
  });

  it("a country-wide alias applies everywhere, and a scoped alias wins over it", async () => {
    await prisma.placeAliases.create({
      data: { nameNorm: "um dabakir", nameDisplay: "Um Dabakir", countryCode: CC, locationId: DISTRICT_B1_ID, source: "seed" },
    });
    expect(await gazetteer("Um Dabakir")).toMatchObject({ source: "ALIAS", locationId: DISTRICT_B1_ID });
    expect(await gazetteer("Um Dabakir", STATE_B_ID)).toMatchObject({ source: "ALIAS", locationId: DISTRICT_B1_ID });
    const scoped = await gazetteer("Um Dabakir", STATE_A_ID);
    expect(scoped).toMatchObject({ source: "ALIAS" });
    expect(scoped!.locationId).not.toBe(DISTRICT_B1_ID);
    // A district target answers with a point on its polygon.
    const point = await gazetteer("Um Dabakir", STATE_B_ID);
    expect(point!.longitude).toBeGreaterThan(72);
    expect(point!.longitude).toBeLessThan(73);
    await prisma.placeAliases.deleteMany({ where: { countryCode: CC, source: "seed" } });
  });

  it("a resolved row is closed", async () => {
    const row = await prisma.unresolvedPlaceNames.findFirstOrThrow({ where: { countryCode: CC, nameNorm: "um dabakir" } });
    await expect(resolve(platform, row.id, { kind: "NOT_A_PLACE" })).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
  });

  it("an existing location answer: a team admin stays inside the state, a platform admin does not", async () => {
    const waiting = await signalAt(STATE_A_ID);
    const row = await queued("Abu Karinka market", STATE_A_ID, [waiting]);

    await expect(resolve(stateAdmin, row.id, { kind: "LOCATION", locationId: DISTRICT_B1_ID })).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    for (const locationId of [COUNTRY_ID, COUNTRY_B_ID, "no-such-location"]) {
      await expect(resolve(platform, row.id, { kind: "LOCATION", locationId })).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    expect((await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("open");

    const resolved = await resolve(stateAdmin, row.id, { kind: "LOCATION", locationId: DISTRICT_A1_ID });
    expect(resolved).toMatchObject({ status: "resolved" });
    expect(await prisma.placeAliases.findUniqueOrThrow({ where: { id: resolved!.placeAliasId! } })).toMatchObject({
      locationId: DISTRICT_A1_ID,
      scopeLocationId: STATE_A_ID,
    });
    expect(await locationOf(waiting)).toBe(DISTRICT_A1_ID);

    // A platform admin may answer with a place in another state of the country.
    const other = await queued("Border post", STATE_A_ID, [await signalAt(STATE_A_ID)]);
    const placed = await resolve(platform, other.id, { kind: "LOCATION", locationId: DISTRICT_B1_ID });
    expect(placed).toMatchObject({ status: "resolved" });
    // The Signal in state A does not move to a place its location does not hold.
    expect(await unresolvedPlaceNameResolvers.UnresolvedPlaceName.signalsMoved(other, null, platform)).toBe(0);
  });

  it("a new point becomes a landmark named after the row, inside the areas CLEAR covers", async () => {
    const waiting = await signalAt(DISTRICT_A2_ID);
    const row = await queued("Aruri", DISTRICT_A2_ID, [waiting]);

    // Outside every loaded area, in another country, and (for a team admin) outside the state.
    await expect(resolve(platform, row.id, { kind: "POINT", point: { lat: 10, lng: 10 } })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    await expect(resolve(platform, row.id, { kind: "POINT", point: { lat: 61, lng: 75 } })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    await expect(resolve(stateAdmin, row.id, { kind: "POINT", point: { lat: 61, lng: 72.5 } })).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });

    const resolved = await resolve(stateAdmin, row.id, { kind: "POINT", point: { lat: 61.2, lng: 71.4 } });
    const alias = await prisma.placeAliases.findUniqueOrThrow({ where: { id: resolved!.placeAliasId! }, include: { location: true } });
    expect(alias.location).toMatchObject({ name: "Aruri", level: 4, parentId: DISTRICT_A2_ID });
    expect(await locationOf(waiting)).toBe(alias.locationId);
  });

  it("a GeoNames answer from another country is refused", async () => {
    const row = await queued("Elsewhere", STATE_A_ID, [await signalAt(STATE_A_ID)]);
    for (const geonamesId of [GN_OTHER_COUNTRY, 1]) {
      await expect(resolve(platform, row.id, { kind: "GEONAMES", geonamesId })).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
  });

  it("not a place closes the row; ambiguous leaves it resolvable", async () => {
    const stop = await queued("Al Kanabi", STATE_A_ID, [await signalAt(STATE_A_ID)]);
    expect(await resolve(stateAdmin, stop.id, { kind: "NOT_A_PLACE" }, "Plural of kambo")).toMatchObject({
      status: "not_a_place",
      resolvedById: STATE_ADMIN_ID,
      resolutionNote: "Plural of kambo",
      placeAliasId: null,
    });
    await expect(resolve(platform, stop.id, { kind: "LOCATION", locationId: DISTRICT_A1_ID })).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });

    const waiting = await signalAt(STATE_A_ID);
    const unsure = await queued("Kamo", STATE_A_ID, [waiting]);
    expect(await resolve(stateAdmin, unsure.id, { kind: "AMBIGUOUS" })).toMatchObject({ status: "ambiguous" });
    await expect(resolve(stateAdmin, unsure.id, { kind: "AMBIGUOUS" })).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
    expect(await locationOf(waiting)).toBe(STATE_A_ID);
    // Someone who knows the place resolves it later.
    expect(await resolve(platform, unsure.id, { kind: "GEONAMES", geonamesId: GN_KAMO })).toMatchObject({ status: "resolved" });
    expect(await locationOf(waiting)).not.toBe(STATE_A_ID);
    expect(await prisma.activityLogs.count({ where: { userId: STATE_ADMIN_ID, action: { in: ["place_name.not_a_place", "place_name.ambiguous"] } } })).toBe(2);
  });

  it("two deciders resolve one row at the same moment: one wins, one alias exists", async () => {
    const waiting = await signalAt(STATE_A_ID);
    const row = await queued("Mazbud", STATE_A_ID, [waiting]);
    const results = await Promise.allSettled([
      resolve(stateAdmin, row.id, { kind: "LOCATION", locationId: DISTRICT_A1_ID }),
      resolve(platform, row.id, { kind: "LOCATION", locationId: DISTRICT_A2_ID }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ extensions: { code: "CONFLICT" } });

    const aliases = await prisma.placeAliases.findMany({ where: { countryCode: CC, nameNorm: "mazbud" } });
    expect(aliases).toHaveLength(1);
    const after = await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "resolved", placeAliasId: aliases[0]!.id });
    expect(await locationOf(waiting)).toBe(aliases[0]!.locationId);
  });

  it("a spelling that has an alias already is a conflict, and nothing is written", async () => {
    const waiting = await signalAt(STATE_A_ID);
    const row = await queued("Tabit", STATE_A_ID, [waiting]);
    await prisma.placeAliases.create({
      data: { nameNorm: "tabit", nameDisplay: "Tabit", countryCode: CC, scopeLocationId: STATE_A_ID, locationId: DISTRICT_A2_ID, source: "manual" },
    });
    await expect(resolve(stateAdmin, row.id, { kind: "LOCATION", locationId: DISTRICT_A1_ID })).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
    expect(await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "open",
      resolvedById: null,
      placeAliasId: null,
    });
    expect(await locationOf(waiting)).toBe(STATE_A_ID);
  });

  it("only a decider in the row's area resolves it", async () => {
    const inB = await queued("Shangil", STATE_B_ID, [await signalAt(STATE_B_ID)]);
    const answer = { kind: "NOT_A_PLACE" as const };
    await expect(resolve(stateAdmin, inB.id, answer)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    for (const context of [analyst, pipeline]) {
      await expect(resolve(context, inB.id, answer)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
    await expect(resolve(platform, "no-such-row", answer)).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect((await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: inB.id } })).status).toBe("open");
  });

  it("each kind takes exactly its own field", async () => {
    const row = await prisma.unresolvedPlaceNames.findFirstOrThrow({ where: { countryCode: CC, status: "open" } });
    const bad = [
      { kind: "LOCATION" as const },
      { kind: "GEONAMES" as const, locationId: DISTRICT_A1_ID },
      { kind: "POINT" as const, geonamesId: GN_KAMO },
      { kind: "NOT_A_PLACE" as const, locationId: DISTRICT_A1_ID },
      { kind: "POINT" as const, point: { lat: 91, lng: 71 } },
    ];
    for (const resolution of bad) {
      await expect(resolve(platform, row.id, resolution)).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    }
  });

  it("suggests GeoNames places and CLEAR places, those inside the area first", async () => {
    const suggestions = await placeNameSuggestions(
      null,
      { name: "Um Dabakeer", nameAr: "أم دباكر", countryCode: CC, withinLocationId: STATE_A_ID },
      stateAdmin,
    );
    const geonames = suggestions.filter((s) => s.kind === "GEONAMES");
    // The one in state A first, though the one in state B is more populous.
    expect(geonames.map((s) => s.geonamesId)).toEqual([GN_UM_DABAKIR_A, GN_UM_DABAKIR_B]);
    expect(geonames[0]).toMatchObject({ name: "Um Dabakir", insideArea: true, distanceKm: 0, score: 1, featureClass: "P" });
    expect(geonames[1]!.insideArea).toBe(false);
    expect(geonames[1]!.distanceKm).toBeGreaterThan(10);
    // The landmark an earlier resolution created is a CLEAR suggestion.
    const places = suggestions.filter((s) => s.kind === "LOCATION");
    expect(places[0]).toMatchObject({ name: "Um Dabakir", level: 4, insideArea: true });
    expect(places[0]!.locationId).toBeTruthy();

    // A district with a similar name; a low trigram floor finds near spellings.
    const districts = await placeNameSuggestions(null, { name: "Abu Karinka", countryCode: CC, withinLocationId: STATE_A_ID }, platform);
    expect(districts.find((s) => s.kind === "LOCATION")).toMatchObject({ locationId: DISTRICT_A1_ID, level: 2, score: 1 });
    const near = await placeNameSuggestions(null, { name: "Kamu", countryCode: CC }, platform);
    expect(near[0]).toMatchObject({ kind: "GEONAMES", geonamesId: GN_KAMO, insideArea: null, distanceKm: null });
  });

  it("suggestions are for deciders", async () => {
    for (const context of [analyst, pipeline]) {
      await expect(placeNameSuggestions(null, { name: "Kamo", countryCode: CC }, context)).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
    }
    await expect(placeNameSuggestions(null, { name: " ", countryCode: CC }, platform)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });
});
