/**
 * Seeding town points for districts whose town GeoNames lacks (Exponential
 * #1709), against the real schema: the plan, the write, and what the
 * gazetteer answers after it.
 *
 * Self-seeding: a country with two states and three districts, a GeoNames
 * district record and a GeoNames town under its own code. All deleted in
 * afterAll: `bun run test:db tests/services/district-town-seed.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { gazetteerResolvers } from "../../src/resolvers/gazetteer.resolver.js";
import {
  applyDistrictTownAliases,
  planDistrictTownAliases,
  type DistrictTown,
} from "../../src/services/district-town-seed.js";
import { normalizeGazetteerName } from "../../src/utils/geonames-normalize.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `dts-db-${Date.now()}`;
const CC = "ZT";
const COUNTRY = `${RUN}-country`;
const STATE_A = `${RUN}-state-a`;
const STATE_B = `${RUN}-state-b`;
const LAIT = `${RUN}-lait`;
const KOSTA = `${RUN}-kosta`;
const OTHER = `${RUN}-other`;
const NOTE = "District town seed test";
const LAIT_ADM2_ID = 990001709;
const KOSTA_TOWN_ID = 990001710;

const pipeline = {
  prisma, user: { id: `${RUN}-pipeline`, role: "pipeline" }, session: null, authMethod: "api-key", locale: "en",
  signalScope: { kind: "full" },
} as unknown as Context;

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

const town = (over: Partial<DistrictTown> & Pick<DistrictTown, "pCode" | "district" | "spellings">, lat: number, lon: number): DistrictTown => ({
  state: "Alfa", group: "A", town: { name: over.district, nameAr: null, lat, lon, source: "osm", ref: "node/42" }, ...over,
});

const TOWNS: DistrictTown[] = [
  // Inside its district; GeoNames has only the district record.
  town({ pCode: "ZT01001", district: "Al Lait", spellings: ["Al Lait", "El Lait", "اللعيت"] }, 50.3, 70.3),
  // 0.1° (~7 km) outside its district: skipped.
  town({ pCode: "ZT01002", district: "Kosta", spellings: ["Kosta Town"] }, 50.5, 72.1),
  // On the edge of its district: moved inside. "Kosta" is a GeoNames town in the state: skipped.
  town({ pCode: "ZT02001", district: "Other - B", spellings: ["Other", "Kosta"] }, 50.5, 73.0),
];

describeIfDb("Seeding town points for districts whose town GeoNames lacks", () => {
  beforeAll(async () => {
    await insertArea(COUNTRY, "Townland", 0, CC, null, box(70, 50, 4, 4));
    await insertArea(STATE_A, "Alfa", 1, "ZT01", COUNTRY, box(70, 50, 2, 4));
    await insertArea(STATE_B, "Beta", 1, "ZT02", COUNTRY, box(72, 50, 2, 4));
    await insertArea(LAIT, "Al Lait", 2, "ZT01001", STATE_A, box(70, 50));
    await insertArea(KOSTA, "Kosta", 2, "ZT01002", STATE_A, box(71, 50));
    await insertArea(OTHER, "Other - B", 2, "ZT02001", STATE_B, box(72, 50));
    // The district record of Al Lait: a point at the centre of the district.
    await prisma.geonames.create({
      data: { geonamesId: LAIT_ADM2_ID, name: "Al Lait", latitude: 50.5, longitude: 70.5, featureClass: "A",
              featureCode: "ADM2", countryCode: CC, population: 0n },
    });
    await prisma.geonamesName.create({ data: { geonamesId: LAIT_ADM2_ID, nameNorm: "al lait", countryCode: CC } });
    // A GeoNames town called Kosta, in state B.
    await prisma.geonames.create({
      data: { geonamesId: KOSTA_TOWN_ID, name: "Kosta", latitude: 51.5, longitude: 73.5, featureClass: "P",
              featureCode: "PPL", countryCode: CC, population: 100n },
    });
    await prisma.geonamesName.create({ data: { geonamesId: KOSTA_TOWN_ID, nameNorm: "kosta", countryCode: CC } });
  });

  afterAll(async () => {
    await prisma.placeAliases.deleteMany({ where: { countryCode: CC } });
    await prisma.geonames.deleteMany({ where: { countryCode: CC } });
    for (const level of [4, 2, 1]) {
      await prisma.locations.deleteMany({ where: { level, ancestorIds: { has: COUNTRY } } });
    }
    await prisma.locations.deleteMany({ where: { id: COUNTRY } });
  });

  it("plans a town inside its district, moves one on the edge, and skips one far outside", async () => {
    const plan = await planDistrictTownAliases(prisma, { countryCode: CC, towns: TOWNS });
    expect(plan.countryLocationId).toBe(COUNTRY);
    expect(plan.towns.map((t) => [t.pCode, t.name, t.stateId])).toEqual([
      ["ZT01001", "Al Lait", STATE_A],
      ["ZT02001", "Other", STATE_B],
    ]);
    expect(plan.towns[0]!.movedKm).toBeNull();
    expect(plan.towns[0]!.osmId).toBe(42n);
    expect(plan.towns[1]!.lon).toBeGreaterThan(72);
    expect(plan.towns[1]!.lon).toBeLessThan(73);
    expect(plan.skippedTowns).toEqual([
      expect.objectContaining({ pCode: "ZT01002", why: expect.stringContaining("outside the district") }),
    ]);
    expect(plan.skippedSpellings).toEqual([
      { pCode: "ZT02001", spelling: "Kosta", why: "GeoNames has a town of this spelling in the state" },
    ]);
  });

  it("writes the towns and aliases; the gazetteer gives the town, not the district record", async () => {
    expect((await gazetteer("Al Lait", STATE_A))?.featureCode).toBe("ADM2");

    const plan = await planDistrictTownAliases(prisma, { countryCode: CC, towns: TOWNS });
    const result = await applyDistrictTownAliases(prisma, plan, { note: NOTE });
    expect(result).toMatchObject({ locationsCreated: 2, locationsReused: 0, created: 4, alreadyThere: 0 });

    const lait = await prisma.locations.findFirstOrThrow({ where: { level: 4, name: "Al Lait", parentId: LAIT } });
    expect(lait.pointType).toBe("seed");
    const hit = await gazetteer("El Lait", STATE_A);
    expect(hit).toMatchObject({ source: "ALIAS", locationId: lait.id, latitude: 50.3, longitude: 70.3 });
    expect((await gazetteer("اللعيت", LAIT))?.locationId).toBe(lait.id);
    // Scoped to its state: a lookup in another state does not get it.
    expect((await gazetteer("El Lait", STATE_B))?.source ?? null).not.toBe("ALIAS");
    const aliases = await prisma.placeAliases.findMany({ where: { countryCode: CC, locationId: lait.id } });
    expect(aliases.map((a) => [a.nameNorm, a.scopeLocationId, a.source]).sort()).toEqual(
      ["Al Lait", "El Lait", "اللعيت"].map((s) => [normalizeGazetteerName(s), STATE_A, "seed"]).sort(),
    );
  });

  it("is safe to run again", async () => {
    const plan = await planDistrictTownAliases(prisma, { countryCode: CC, towns: TOWNS });
    expect(plan.towns.every((t) => t.existingLocationId)).toBe(true);
    const result = await applyDistrictTownAliases(prisma, plan, { note: NOTE });
    expect(result).toMatchObject({ locationsCreated: 0, locationsReused: 2, created: 0, alreadyThere: 4 });
    expect(await prisma.locations.count({ where: { level: 4, ancestorIds: { has: COUNTRY } } })).toBe(2);
  });
});
