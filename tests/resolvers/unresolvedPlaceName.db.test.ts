/**
 * Unresolved place names against the real schema (ADR-0019): the queue key
 * with NULLS NOT DISTINCT, the CHECK constraints, the record mutation (one
 * count per Signal, dates from `seenAt`, closed rows stay closed), who reads
 * the queue, and the GeoNames re-import leaving CLEAR's tables alone.
 *
 * Self-seeding: two countries (one with no ISO code on its location, as
 * `ensureCountryLocation` makes them), two states, a district, two teams with an
 * admin each, an analyst, a data source and Signals. All deleted in afterAll,
 * so it runs against an empty scratch database:
 * `bun run test:db tests/resolvers/unresolvedPlaceName.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { unresolvedPlaceNameResolvers } from "../../src/resolvers/unresolvedPlaceName.resolver.js";
import { GEONAMES_TRUNCATE_SQL } from "../../src/utils/geonames-normalize.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { recordUnresolvedPlaceName } = unresolvedPlaceNameResolvers.Mutation;
const { unresolvedPlaceNames } = unresolvedPlaceNameResolvers.Query;

const RUN = `upn-db-${Date.now()}`;
/** Unused ISO codes, so the rows never meet real data. */
const CC = "ZX";
const CC_B = "ZW";
const COUNTRY_ID = `${RUN}-country`;
const COUNTRY_B_ID = `${RUN}-country-b`;
const STATE_A_ID = `${RUN}-state-a`;
const STATE_B_ID = `${RUN}-state-b`;
const DISTRICT_ID = `${RUN}-district`;
const ORG_ID = `${RUN}-org`;
const STATE_TEAM_ID = `${RUN}-team-state`;
const COUNTRY_TEAM_ID = `${RUN}-team-country`;
const STATE_ADMIN_ID = `${RUN}-state-admin`;
const COUNTRY_ADMIN_ID = `${RUN}-country-admin`;
const ANALYST_ID = `${RUN}-analyst`;
const PLATFORM_ID = `${RUN}-platform`;
const USER_IDS = [STATE_ADMIN_ID, COUNTRY_ADMIN_ID, ANALYST_ID, PLATFORM_ID];

const as = (id: string, role: string, authMethod = "session"): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod, locale: "en", signalScope: { kind: "full" } }) as unknown as Context;
const pipeline = as(`${RUN}-pipeline`, "pipeline", "api-key");
const platform = as(PLATFORM_ID, "admin");
const stateAdmin = as(STATE_ADMIN_ID, "member");
const countryAdmin = as(COUNTRY_ADMIN_ID, "member");
const analyst = as(ANALYST_ID, "member");

let sourceId: string | undefined;
const signalIds: string[] = [];

const record = (
  signal: number,
  name: string,
  areaLocationId: string,
  extra: { nameAr?: string; reason?: "no_match" | "outside_area"; seenAt?: Date; countryCode?: string } = {},
) =>
  recordUnresolvedPlaceName(
    null,
    { input: { signalId: signalIds[signal]!, name, countryCode: CC, areaLocationId, ...extra } },
    pipeline,
  );

const queue = (context: Context, args: Parameters<typeof unresolvedPlaceNames>[1] = {}) =>
  unresolvedPlaceNames(null, { countryCode: CC, ...args }, context);

async function insertArea(id: string, name: string, level: number, parentId: string | null, pCode: string | null, wkt: string) {
  const ancestors = parentId
    ? [parentId, ...(await prisma.locations.findUniqueOrThrow({ where: { id: parentId } })).ancestorIds]
    : [];
  await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "p_code", "ancestor_ids", "geometry")
    VALUES (${id}, ${name}, ${level}, ${parentId}, ${pCode}, ${ancestors}::text[], ST_GeomFromText(${wkt}, 4326))`;
}

describeIfDb("Unresolved place names against the real schema", () => {
  beforeAll(async () => {
    for (const id of USER_IDS) {
      await prisma.user.create({
        data: { id, name: id, email: `${id}@example.test`, role: id === PLATFORM_ID ? "admin" : "member" },
      });
    }
    await prisma.organisations.create({ data: { id: ORG_ID, name: "UPN DB Org", slug: ORG_ID } });
    await prisma.teams.createMany({
      data: [
        { id: STATE_TEAM_ID, organisationId: ORG_ID, name: "State team", slug: STATE_TEAM_ID },
        { id: COUNTRY_TEAM_ID, organisationId: ORG_ID, name: "Country team", slug: COUNTRY_TEAM_ID },
      ],
    });
    await prisma.teamMembers.createMany({
      data: [
        { teamId: STATE_TEAM_ID, userId: STATE_ADMIN_ID, role: "team_admin" },
        { teamId: STATE_TEAM_ID, userId: ANALYST_ID, role: "analyst" },
        { teamId: COUNTRY_TEAM_ID, userId: COUNTRY_ADMIN_ID, role: "team_admin" },
      ],
    });

    // No p_code: the queue must not depend on a country location carrying its ISO code.
    await insertArea(COUNTRY_ID, "Testland", 0, null, null, "MULTIPOLYGON(((60 60, 64 60, 64 64, 60 64, 60 60)))");
    await insertArea(STATE_A_ID, "State A", 1, COUNTRY_ID, null, "MULTIPOLYGON(((60 60, 62 60, 62 64, 60 64, 60 60)))");
    await insertArea(STATE_B_ID, "State B", 1, COUNTRY_ID, null, "MULTIPOLYGON(((62 60, 64 60, 64 64, 62 64, 62 60)))");
    await insertArea(DISTRICT_ID, "District A1", 2, STATE_A_ID, null, "MULTIPOLYGON(((60 60, 61 60, 61 61, 60 61, 60 60)))");
    await insertArea(COUNTRY_B_ID, "Otherland", 0, null, CC_B, "MULTIPOLYGON(((64 60, 68 60, 68 64, 64 64, 64 60)))");
    await prisma.teamLocations.createMany({
      data: [
        { teamId: STATE_TEAM_ID, locationId: STATE_A_ID },
        { teamId: COUNTRY_TEAM_ID, locationId: COUNTRY_ID },
      ],
    });

    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
    for (let i = 0; i < 6; i++) {
      const signal = await prisma.signals.create({
        data: {
          sourceId,
          rawData: {},
          contentHash: `h${i}`,
          title: `Post ${i}`,
          publishedAt: new Date("2026-10-20T00:00:00.000Z"),
          locationId: STATE_A_ID,
          countries: { connect: [{ id: COUNTRY_ID }] },
        },
      });
      signalIds.push(signal.id);
    }
  });

  afterAll(async () => {
    // Queue rows and aliases first: a state is not deleted while a row holds it.
    await prisma.unresolvedPlaceNames.deleteMany({ where: { countryCode: { in: [CC, CC_B] } } });
    await prisma.placeAliases.deleteMany({ where: { countryCode: { in: [CC, CC_B] } } });
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.teamLocations.deleteMany({ where: { teamId: { in: [STATE_TEAM_ID, COUNTRY_TEAM_ID] } } });
    await prisma.locations.deleteMany({ where: { id: DISTRICT_ID } });
    await prisma.locations.deleteMany({ where: { id: { in: [STATE_A_ID, STATE_B_ID] } } });
    await prisma.locations.deleteMany({ where: { id: { in: [COUNTRY_ID, COUNTRY_B_ID] } } });
    await prisma.teamMembers.deleteMany({ where: { teamId: { in: [STATE_TEAM_ID, COUNTRY_TEAM_ID] } } });
    await prisma.teams.deleteMany({ where: { id: { in: [STATE_TEAM_ID, COUNTRY_TEAM_ID] } } });
    await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
    await prisma.organisations.deleteMany({ where: { id: ORG_ID } });
  });

  it("records a miss: the state comes from the area, the spelling is normalised", async () => {
    const row = await record(0, "Um-Dabākir", DISTRICT_ID, { nameAr: "أم دباكر", reason: "outside_area" });
    expect(row).toMatchObject({
      nameNorm: "um dabakir",
      nameAsWritten: "Um-Dabākir",
      nameAr: "أم دباكر",
      countryCode: CC,
      stateLocationId: STATE_A_ID,
      countryLocationId: COUNTRY_ID,
      status: "open",
      signalCount: 1,
    });
    const links = await prisma.unresolvedPlaceNameSignals.findMany({ where: { unresolvedPlaceNameId: row!.id } });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      signalId: signalIds[0],
      areaLocationId: DISTRICT_ID,
      nameAsWritten: "Um-Dabākir",
      reason: "outside_area",
      relocatedAt: null,
    });
  });

  it("counts a Signal once: a re-run changes nothing", async () => {
    const before = await record(0, "Um Dabakir", DISTRICT_ID);
    const again = await record(0, "um dabakir", STATE_A_ID);
    expect(again!.id).toBe(before!.id);
    expect(again!.signalCount).toBe(1);
    expect(await prisma.unresolvedPlaceNameSignals.count({ where: { unresolvedPlaceNameId: before!.id } })).toBe(1);
  });

  it("adds a second Signal, and keeps the earliest and latest seenAt of a backfill", async () => {
    const first = await record(0, "Um Dabakir", DISTRICT_ID);
    const early = new Date("2026-08-03T10:00:00.000Z");
    const row = await record(1, "Um Dabakir", STATE_A_ID, { seenAt: early });
    expect(row!.id).toBe(first!.id);
    expect(row!.signalCount).toBe(2);
    expect(row!.firstSeenAt).toEqual(early);
    expect(row!.lastSeenAt).toEqual(first!.lastSeenAt);
    const link = await prisma.unresolvedPlaceNameSignals.findUniqueOrThrow({
      where: { unresolvedPlaceNameId_signalId: { unresolvedPlaceNameId: row!.id, signalId: signalIds[1]! } },
    });
    expect(link).toMatchObject({ seenAt: early, reason: "no_match", nameAsWritten: "Um Dabakir" });
  });

  it("the same spelling in another state is another row", async () => {
    const a = await record(0, "Um Dabakir", STATE_A_ID);
    const b = await record(2, "Um Dabakir", STATE_B_ID);
    expect(b!.id).not.toBe(a!.id);
    expect(b).toMatchObject({ stateLocationId: STATE_B_ID, signalCount: 1 });
  });

  it("a country-level spelling is one row: the unique keys use NULLS NOT DISTINCT", async () => {
    const a = await record(3, "Merowe Dam", COUNTRY_ID);
    const b = await record(4, "Merowe Dam", COUNTRY_ID);
    expect(a).toMatchObject({ stateLocationId: null, countryLocationId: COUNTRY_ID, signalCount: 1 });
    expect(b!.id).toBe(a!.id);
    expect(b!.signalCount).toBe(2);
    expect(await prisma.unresolvedPlaceNames.count({ where: { countryCode: CC, nameNorm: "merowe dam" } })).toBe(1);

    // The database refuses the duplicate too, for the queue and for aliases.
    const now = new Date();
    await expect(
      prisma.unresolvedPlaceNames.create({
        data: { nameNorm: "merowe dam", nameAsWritten: "Merowe Dam", countryCode: CC, firstSeenAt: now, lastSeenAt: now },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    const alias = { nameNorm: "merowe dam", nameDisplay: "Merowe Dam", countryCode: CC, locationId: STATE_B_ID, source: "seed" };
    await prisma.placeAliases.create({ data: alias });
    await expect(prisma.placeAliases.create({ data: alias })).rejects.toMatchObject({ code: "P2002" });
    // A state-scoped alias with the same spelling is a different key.
    await prisma.placeAliases.create({ data: { ...alias, scopeLocationId: STATE_A_ID } });
  });

  it("a row marked not a place stays closed: only its count and lastSeenAt change", async () => {
    const opened = await record(3, "Al Kanabi", STATE_A_ID, { seenAt: new Date("2026-10-01T00:00:00.000Z") });
    await prisma.unresolvedPlaceNames.update({ where: { id: opened!.id }, data: { status: "not_a_place" } });
    const later = new Date("2026-11-02T00:00:00.000Z");
    const row = await record(4, "Al-Kanabi", STATE_A_ID, { seenAt: later });
    expect(row).toMatchObject({ id: opened!.id, status: "not_a_place", signalCount: 2, lastSeenAt: later });
    expect(row!.firstSeenAt).toEqual(opened!.firstSeenAt);
  });

  it("the database rejects a status, reason or source outside the known sets", async () => {
    const now = new Date();
    await expect(
      prisma.unresolvedPlaceNames.create({
        data: { nameNorm: "x", nameAsWritten: "x", countryCode: CC_B, status: "closed", firstSeenAt: now, lastSeenAt: now },
      }),
    ).rejects.toThrow(/unresolved_place_names_status_check/);
    const row = await prisma.unresolvedPlaceNames.findFirstOrThrow({ where: { countryCode: CC } });
    await expect(
      prisma.unresolvedPlaceNameSignals.create({
        data: { unresolvedPlaceNameId: row.id, signalId: signalIds[5]!, nameAsWritten: "x", reason: "other", seenAt: now },
      }),
    ).rejects.toThrow(/unresolved_place_name_signals_reason_check/);
    await expect(
      prisma.placeAliases.create({
        data: { nameNorm: "x", nameDisplay: "x", countryCode: CC_B, locationId: STATE_A_ID, source: "guess" },
      }),
    ).rejects.toThrow(/place_aliases_source_check/);
  });

  it("refuses an unknown Signal, an unknown area, an area in another country and an empty name", async () => {
    const input = { signalId: signalIds[0]!, name: "Kamo", countryCode: CC, areaLocationId: STATE_A_ID };
    await expect(recordUnresolvedPlaceName(null, { input: { ...input, signalId: "no-such-signal" } }, pipeline)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    for (const bad of [{ areaLocationId: "no-such-location" }, { areaLocationId: COUNTRY_B_ID }, { name: " -- " }, { countryCode: "SDN" }]) {
      await expect(recordUnresolvedPlaceName(null, { input: { ...input, ...bad } }, pipeline)).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    expect(await prisma.unresolvedPlaceNames.count({ where: { countryCode: CC, nameNorm: "kamo" } })).toBe(0);
  });

  it("a platform admin reads every row: open first, then by Signal count", async () => {
    const page = await queue(platform);
    // State A "um dabakir" (2), country "merowe dam" (2), State B "um dabakir" (1), then the closed row.
    expect(page.totalCount).toBe(4);
    expect(page.hasMore).toBe(false);
    expect(page.items.map((r) => r.status)).toEqual(["open", "open", "open", "not_a_place"]);
    expect(page.items.slice(0, 3).map((r) => r.signalCount)).toEqual([2, 2, 1]);
    expect(page.items[3]).toMatchObject({ nameNorm: "al kanabi", signalCount: 2 });
  });

  it("filters by status and area, and pages", async () => {
    expect((await queue(platform, { status: "not_a_place" })).items.map((r) => r.nameNorm)).toEqual(["al kanabi"]);
    expect((await queue(platform, { areaLocationId: STATE_B_ID })).items.map((r) => r.stateLocationId)).toEqual([STATE_B_ID]);
    // A district keeps the rows of its state; a country keeps all of its rows.
    expect((await queue(platform, { areaLocationId: DISTRICT_ID, status: "open" })).items.map((r) => r.stateLocationId)).toEqual([STATE_A_ID]);
    expect((await unresolvedPlaceNames(null, { areaLocationId: COUNTRY_ID }, platform)).totalCount).toBe(4);
    expect((await unresolvedPlaceNames(null, { areaLocationId: COUNTRY_B_ID }, platform)).totalCount).toBe(0);

    const first = await queue(platform, { first: 2 });
    expect(first).toMatchObject({ totalCount: 4, hasMore: true });
    const rest = await queue(platform, { first: 2, offset: 2 });
    expect(rest.hasMore).toBe(false);
    expect([...first.items, ...rest.items].map((r) => r.id)).toEqual((await queue(platform)).items.map((r) => r.id));
  });

  it("a team admin reads the rows inside their team's area only", async () => {
    const stateRows = await queue(stateAdmin);
    expect(stateRows.totalCount).toBe(2);
    expect(stateRows.items.every((r) => r.stateLocationId === STATE_A_ID)).toBe(true);
    // A team that covers the country also reads the rows with no state. The
    // country location carries no ISO code here: the row's country location decides.
    const countryRows = await queue(countryAdmin);
    expect(countryRows.totalCount).toBe(4);
    expect(countryRows.items.some((r) => r.stateLocationId === null)).toBe(true);
    expect((await queue(countryAdmin, { areaLocationId: COUNTRY_ID })).totalCount).toBe(4);
  });

  it("an analyst and the pipeline may not read the queue", async () => {
    for (const context of [analyst, pipeline]) {
      await expect(queue(context)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
  });

  it("lists a row's Signals, newest first", async () => {
    const row = await prisma.unresolvedPlaceNames.findFirstOrThrow({
      where: { countryCode: CC, nameNorm: "um dabakir", stateLocationId: STATE_A_ID },
    });
    const links = await unresolvedPlaceNameResolvers.UnresolvedPlaceName.signals(row, { first: 5 }, platform);
    expect(links.map((l) => l.signalId)).toEqual([signalIds[0], signalIds[1]]);
    const signal = await unresolvedPlaceNameResolvers.UnresolvedPlaceNameSignal.signal(links[0]!, null, platform);
    expect(signal).toMatchObject({ id: signalIds[0], title: "Post 0" });
  });

  it("no foreign key ties CLEAR's tables to the GeoNames tables", async () => {
    const fks = await prisma.$queryRaw<{ name: string }[]>`
      SELECT c.conname AS "name"
      FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid::regclass::text IN ('unresolved_place_names', 'unresolved_place_name_signals', 'place_aliases')
        AND c.confrelid::regclass::text IN ('geonames', 'geonames_name')`;
    expect(fks).toEqual([]);
  });

  it("a GeoNames re-import leaves all three tables untouched", async () => {
    const counts = () =>
      Promise.all([
        prisma.unresolvedPlaceNames.count({ where: { countryCode: CC } }),
        prisma.unresolvedPlaceNameSignals.count({ where: { signalId: { in: signalIds } } }),
        prisma.placeAliases.count({ where: { countryCode: CC } }),
      ]);
    const before = await counts();
    expect(before.every((n) => n > 0)).toBe(true);

    await prisma.geonames.create({
      data: { geonamesId: 990001307, name: "Um Dabakir", latitude: 61, longitude: 61, countryCode: CC },
    });
    await prisma.geonamesName.create({ data: { geonamesId: 990001307, nameNorm: "um dabakir", countryCode: CC } });

    // The importer's own statement, in a transaction that rolls back, so a
    // gazetteer loaded into this database survives the test.
    const rollback = new Error("rollback");
    let inside: { geonames: number; clear: number[] } | undefined;
    await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(GEONAMES_TRUNCATE_SQL);
        inside = {
          geonames: (await tx.geonames.count()) + (await tx.geonamesName.count()),
          clear: [
            await tx.unresolvedPlaceNames.count({ where: { countryCode: CC } }),
            await tx.unresolvedPlaceNameSignals.count({ where: { signalId: { in: signalIds } } }),
            await tx.placeAliases.count({ where: { countryCode: CC } }),
          ],
        };
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });
    await prisma.geonames.deleteMany({ where: { geonamesId: 990001307 } });

    expect(inside).toEqual({ geonames: 0, clear: before });
    expect(await counts()).toEqual(before);
  });
});
