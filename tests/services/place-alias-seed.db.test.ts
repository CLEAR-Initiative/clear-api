/**
 * Seeding place aliases from a list of admin names in Arabic (ADR-0019,
 * Exponential #1417), against the real schema: the plan, the write, and the
 * queue rows the seed closes.
 *
 * Self-seeding: a country with two states and six districts, GeoNames rows
 * under its own code, a queue row and its Signal. All deleted in afterAll:
 * `bun run test:db tests/services/place-alias-seed.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { gazetteerResolvers } from "../../src/resolvers/gazetteer.resolver.js";
import { unresolvedPlaceNameResolvers } from "../../src/resolvers/unresolvedPlaceName.resolver.js";
import {
  applyAdminNameAliases,
  arabicSpellings,
  planAdminNameAliases,
  type AdminArabicName,
} from "../../src/services/place-alias-seed.js";
import { normalizeGazetteerName } from "../../src/utils/geonames-normalize.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `pas-db-${Date.now()}`;
const CC = "ZQ";
const COUNTRY = `${RUN}-country`;
const STATE_A = `${RUN}-state-a`;
const STATE_B = `${RUN}-state-b`;
const UM_BARU = `${RUN}-um-baru`;
const ALFA_TOWN = `${RUN}-alfa-town`;
const RAHAD_A = `${RUN}-rahad-a`;
const RAHAD_B = `${RUN}-rahad-b`;
const RURAL_KASALA = `${RUN}-rural-kasala`;
const KOSTI = `${RUN}-kosti`;
const NOTE = "Seed test";
const KOSTI_GEONAMES_ID = 990001417;

const pipeline = {
  prisma, user: { id: `${RUN}-pipeline`, role: "pipeline" }, session: null, authMethod: "api-key", locale: "en",
  signalScope: { kind: "full" },
} as unknown as Context;

const ROWS: AdminArabicName[] = [
  { pCode: "ZQ01", level: 1, name: "Alfa", nameAr: "الفا" },
  { pCode: "ZQ02", level: 1, name: "Beta", nameAr: "بيتا" },
  { pCode: "ZQ01001", level: 2, name: "Um Baru", nameAr: "أم برو" },
  { pCode: "ZQ01002", level: 2, name: "Alfa town", nameAr: "مدينة الفا" },
  { pCode: "ZQ01003", level: 2, name: "Ar Rahad", nameAr: "الرهد" },
  { pCode: "ZQ02001", level: 2, name: "Ar Rahad", nameAr: "الرهد" },
  { pCode: "ZQ02002", level: 2, name: "Reifi Kasala", nameAr: "ريفى كسلا - ب" },
  { pCode: "ZQ02003", level: 2, name: "Kosti", nameAr: "كوستي" },
  { pCode: "ZQ09999", level: 2, name: "Nowhere", nameAr: "لا مكان" },
];

let sourceId: string | undefined;
let signalId: string;
let queueRowId: string;

async function insertArea(id: string, name: string, level: number, pCode: string, parentId: string | null, wkt: string) {
  const ancestors = parentId
    ? [parentId, ...(await prisma.locations.findUniqueOrThrow({ where: { id: parentId } })).ancestorIds]
    : [];
  await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "p_code", "parent_id", "ancestor_ids", "geometry")
    VALUES (${id}, ${name}, ${level}, ${pCode}, ${parentId}, ${ancestors}::text[], ST_GeomFromText(${wkt}, 4326))`;
}

const box = (x: number, y: number, w = 1, h = 1) =>
  `MULTIPOLYGON(((${x} ${y}, ${x + w} ${y}, ${x + w} ${y + h}, ${x} ${y + h}, ${x} ${y})))`;

const gazetteer = (name: string, withinLocationId?: string) =>
  gazetteerResolvers.Query.resolveGazetteerLocation(undefined, { name, countryCode: CC, withinLocationId }, pipeline);

const plan = () => planAdminNameAliases(prisma, { countryCode: CC, rows: ROWS, extra: { ZQ02002: ["كسيلا"] } });

it("derives the spellings a post may use from an official name", () => {
  expect(arabicSpellings("ريفى خشم القربة")).toEqual(["ريفى خشم القربة", "خشم القربة"]);
  expect(arabicSpellings("مدينة القضارف")).toEqual(["مدينة القضارف", "القضارف"]);
  expect(arabicSpellings("التضامن - ج ك")).toEqual(["التضامن - ج ك", "التضامن"]);
  expect(arabicSpellings("أم برو")).toEqual(["أم برو", "أمبرو"]);
  expect(arabicSpellings("أبو حمد")).toEqual(["أبو حمد", "أبوحمد"]);
  expect(arabicSpellings("كوستي")).toEqual(["كوستي"]);
});

describeIfDb("Seeding place aliases from admin names in Arabic", () => {
  beforeAll(async () => {
    await insertArea(COUNTRY, "Seedland", 0, CC, null, box(70, 50, 4, 4));
    await insertArea(STATE_A, "Alfa", 1, "ZQ01", COUNTRY, box(70, 50, 2, 4));
    await insertArea(STATE_B, "Beta", 1, "ZQ02", COUNTRY, box(72, 50, 2, 4));
    await insertArea(UM_BARU, "Um Baru", 2, "ZQ01001", STATE_A, box(70, 50));
    await insertArea(ALFA_TOWN, "Alfa town", 2, "ZQ01002", STATE_A, box(71, 50));
    await insertArea(RAHAD_A, "Ar Rahad", 2, "ZQ01003", STATE_A, box(70, 51));
    await insertArea(RAHAD_B, "Ar Rahad", 2, "ZQ02001", STATE_B, box(72, 50));
    await insertArea(RURAL_KASALA, "Reifi Kasala", 2, "ZQ02002", STATE_B, box(73, 50));
    await insertArea(KOSTI, "Kosti", 2, "ZQ02003", STATE_B, box(72, 51));
    // GeoNames already holds the town of Kosti, inside its district.
    await prisma.geonames.create({
      data: { geonamesId: KOSTI_GEONAMES_ID, name: "Kosti", latitude: 51.5, longitude: 72.5, featureClass: "P",
              featureCode: "PPL", countryCode: CC, population: 9000n },
    });
    await prisma.geonamesName.create({
      data: { geonamesId: KOSTI_GEONAMES_ID, nameNorm: normalizeGazetteerName("كوستي"), countryCode: CC },
    });
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
    // A post stored at state level, waiting on the name "Amberu" (أمبرو).
    signalId = (
      await prisma.signals.create({
        data: { sourceId, rawData: {}, contentHash: `${RUN}-h`, title: "Post", publishedAt: new Date("2026-11-10T00:00:00.000Z"),
                locationId: STATE_A, countries: { connect: [{ id: COUNTRY }] } },
      })
    ).id;
    const row = await unresolvedPlaceNameResolvers.Mutation.recordUnresolvedPlaceName(
      null,
      { input: { signalId, name: "Amberu", nameAr: "أمبرو", countryCode: CC, areaLocationId: STATE_A } },
      pipeline,
    );
    queueRowId = row!.id;
  });

  afterAll(async () => {
    await prisma.unresolvedPlaceNames.deleteMany({ where: { countryCode: CC } });
    await prisma.placeAliases.deleteMany({ where: { countryCode: CC } });
    await prisma.geonames.deleteMany({ where: { countryCode: CC } });
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    for (const level of [4, 2, 1]) {
      await prisma.locations.deleteMany({ where: { level, ancestorIds: { has: COUNTRY } } });
    }
    await prisma.locations.deleteMany({ where: { id: COUNTRY } });
  });

  it("plans one alias per spelling and settles the names that two areas share", async () => {
    const p = await plan();
    const target = (spelling: string) =>
      p.aliases.filter((a) => a.nameNorm === normalizeGazetteerName(spelling)).map((a) => [a.locationId, a.scopeLocationId]);

    expect(p.countryLocationId).toBe(COUNTRY);
    // A district's name and its joined form, country-wide.
    expect(target("أم برو")).toEqual([[UM_BARU, null]]);
    expect(target("أمبرو")).toEqual([[UM_BARU, null]]);
    // A state and a district share a name: the state gets it.
    expect(target("الفا")).toEqual([[STATE_A, null]]);
    expect(target("مدينة الفا")).toEqual([[ALFA_TOWN, null]]);
    // Districts of two states share a name: one alias each, scoped to its state.
    expect(target("الرهد").sort()).toEqual([[RAHAD_A, STATE_A], [RAHAD_B, STATE_B]].sort());
    // Short forms and a spelling given by hand.
    expect(target("كسلا")).toEqual([[RURAL_KASALA, null]]);
    expect(target("كسيلا")).toEqual([[RURAL_KASALA, null]]);

    expect(p.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pCode: "ZQ09999", why: expect.stringContaining("no location") }),
        expect.objectContaining({ pCode: "ZQ01002", spelling: "الفا", why: expect.stringContaining("the state gets it") }),
      ]),
    );
  });

  it("marks a spelling GeoNames already answers inside the district", async () => {
    const p = await plan();
    const known = p.aliases.filter((a) => a.knownToGeonames).map((a) => a.locationId);
    expect(known).toEqual([KOSTI]);
  });

  it("writes the aliases as a seed, and the gazetteer answers with the CLEAR location", async () => {
    const p = await plan();
    const chosen = p.aliases.filter((a) => !a.knownToGeonames);
    const result = await applyAdminNameAliases(prisma, { countryCode: CC, aliases: chosen }, { note: NOTE });
    expect(result).toMatchObject({ created: chosen.length, alreadyThere: 0 });

    const stored = await prisma.placeAliases.findMany({ where: { countryCode: CC } });
    expect(stored).toHaveLength(chosen.length);
    expect(stored.every((a) => a.source === "seed" && a.createdById === null && a.note === NOTE)).toBe(true);

    expect(await gazetteer("أمبرو")).toMatchObject({ source: "ALIAS", locationId: UM_BARU, exact: true });
    // A post writes it with the prefix "محلية": the pipeline asks for the name alone.
    expect(await gazetteer("أم برو", STATE_A)).toMatchObject({ source: "ALIAS", locationId: UM_BARU });
    // The scoped alias of the state asked about wins.
    expect(await gazetteer("الرهد", STATE_B)).toMatchObject({ locationId: RAHAD_B });
    expect(await gazetteer("الرهد", RAHAD_A)).toMatchObject({ locationId: RAHAD_A });
    // The town GeoNames holds keeps its point: no alias replaced it.
    expect(await gazetteer("كوستي")).toMatchObject({ source: "GEONAMES", geonamesId: KOSTI_GEONAMES_ID });
  });

  it("closes the open queue row its Arabic spelling answers, and moves the waiting Signal", async () => {
    const row = await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: queueRowId }, include: { placeAlias: true } });
    expect(row).toMatchObject({ status: "resolved", resolvedById: null, resolutionNote: NOTE });
    expect(row.placeAlias).toMatchObject({ locationId: UM_BARU, source: "seed" });
    expect((await prisma.signals.findUniqueOrThrow({ where: { id: signalId } })).locationId).toBe(UM_BARU);
  });

  it("leaves a queue row to an alias made by hand that answers it in its state", async () => {
    // A person mapped "كسيلا" to a district of State B, for State B only.
    // The seed's country-wide alias for the same spelling must not close a
    // State B row with its own target.
    await prisma.placeAliases.deleteMany({ where: { countryCode: CC, nameNorm: normalizeGazetteerName("كسيلا") } });
    const manual = await prisma.placeAliases.create({
      data: { nameNorm: normalizeGazetteerName("كسيلا"), nameDisplay: "كسيلا", countryCode: CC, scopeLocationId: STATE_B,
              locationId: RAHAD_B, source: "manual" },
    });
    const waiting = (
      await prisma.signals.create({
        data: { sourceId: sourceId!, rawData: {}, contentHash: `${RUN}-h2`, title: "Post 2",
                publishedAt: new Date("2026-11-10T00:00:00.000Z"), locationId: STATE_B, countries: { connect: [{ id: COUNTRY }] } },
      })
    ).id;
    const row = await unresolvedPlaceNameResolvers.Mutation.recordUnresolvedPlaceName(
      null,
      { input: { signalId: waiting, name: "Kaseila", nameAr: "كسيلا", countryCode: CC, areaLocationId: STATE_B } },
      pipeline,
    );

    const p = await plan();
    const result = await applyAdminNameAliases(prisma, { countryCode: CC, aliases: p.aliases.filter((a) => !a.knownToGeonames) }, { note: NOTE });
    expect(result).toMatchObject({ created: 1, rowsResolved: 0, signalsMoved: 0 });
    expect(await prisma.unresolvedPlaceNames.findUniqueOrThrow({ where: { id: row!.id } })).toMatchObject({ status: "open", placeAliasId: null });
    expect((await prisma.signals.findUniqueOrThrow({ where: { id: waiting } })).locationId).toBe(STATE_B);
    expect(await gazetteer("كسيلا", STATE_B)).toMatchObject({ locationId: RAHAD_B });
    await prisma.placeAliases.delete({ where: { id: manual.id } });
    await prisma.unresolvedPlaceNames.delete({ where: { id: row!.id } });
  });

  it("changes nothing when it runs again, and leaves an alias made by hand as it is", async () => {
    await prisma.placeAliases.create({
      data: { nameNorm: normalizeGazetteerName("كوستي"), nameDisplay: "كوستي", countryCode: CC, locationId: RAHAD_B, source: "manual" },
    });
    const p = await plan();
    const result = await applyAdminNameAliases(prisma, { countryCode: CC, aliases: p.aliases }, { note: NOTE });
    // Only Kosti's spelling was new to the table, and a person had taken it.
    expect(result).toMatchObject({ created: 0, alreadyThere: p.aliases.length, rowsResolved: 0, signalsMoved: 0 });
    expect(await gazetteer("كوستي")).toMatchObject({ source: "ALIAS", locationId: RAHAD_B });
  });
});
