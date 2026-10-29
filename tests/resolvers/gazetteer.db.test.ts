/**
 * Integration tests for `resolveGazetteerLocation` against the real, migrated
 * schema: the exact tier, the pg_trgm fuzzy tier, and Arabic names.
 *
 * Self-seeding: rows are written under the unused country code "ZZ" (and
 * queried with it), so they never meet a loaded gazetteer, and are deleted in
 * afterAll: `bun run test:db tests/resolvers/gazetteer.db.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { gazetteerResolvers } from "../../src/resolvers/gazetteer.resolver.js";
import { normalizeGazetteerName } from "../../src/utils/geonames-normalize.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const CC = "ZZ";
const PIPELINE: Context = {
  prisma,
  user: { id: "gazetteer-db-pipeline", role: "pipeline" },
  session: null,
  authMethod: "api-key",
} as unknown as Context;

// GeoNames rows as the importer would load them: every spelling normalised.
const PLACES = [
  { geonamesId: 990000001, name: "Kadugli", lat: 11.01, lng: 29.72, pop: 87666n, names: ["Kadugli", "Kaduqli", "كادقلي"] },
  { geonamesId: 990000002, name: "Tendalti", lat: 13.12, lng: 32.06, pop: 0n, names: ["Tendalti", "تندلتي"] },
  { geonamesId: 990000003, name: "Rabak", lat: 13.18, lng: 32.74, pop: 135281n, names: ["Rabak", "ربك", "ربک", "رباک"] },
  // Two places with one name: the more populous one lies outside AREA.
  { geonamesId: 990000004, name: "Al Abyad", lat: 13.5, lng: 27.5, pop: 9000n, names: ["Al Abyad", "الابيض"] },
  { geonamesId: 990000005, name: "Al Abyad", lat: 11.9, lng: 28.2, pop: 300n, names: ["Al Abyad", "الابيض"] },
];

// A stand-in admin area (West Kordofan-ish) containing only the second Al Abyad.
const AREA = "gazetteer-db-area";

const resolve = (name: string, minSimilarity?: number, withinLocationId?: string) =>
  gazetteerResolvers.Query.resolveGazetteerLocation(
    undefined,
    { name, countryCode: CC, minSimilarity, withinLocationId },
    PIPELINE,
  );

describeIfDb("resolveGazetteerLocation", () => {
  beforeAll(async () => {
    await prisma.geonames.createMany({
      data: PLACES.map((p) => ({
        geonamesId: p.geonamesId,
        name: p.name,
        latitude: p.lat,
        longitude: p.lng,
        featureClass: "P",
        featureCode: "PPL",
        countryCode: CC,
        population: p.pop,
      })),
    });
    await prisma.geonamesName.createMany({
      data: PLACES.flatMap((p) =>
        [...new Set(p.names.map(normalizeGazetteerName))].map((nameNorm) => ({
          geonamesId: p.geonamesId,
          nameNorm,
          countryCode: CC,
        })),
      ),
    });
  });

  beforeAll(async () => {
    await prisma.$executeRaw`
      INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${AREA}, 'Gazetteer test area', 1, ARRAY[]::text[],
              ST_GeomFromText('MULTIPOLYGON(((27 10, 30 10, 30 13, 27 13, 27 10)))', 4326))
    `;
  });

  afterAll(async () => {
    await prisma.geonames.deleteMany({ where: { countryCode: CC } });
    await prisma.$executeRaw`DELETE FROM "locations" WHERE "id" = ${AREA}`;
  });

  it("matches a Latin name exactly", async () => {
    const hit = await resolve("Kaduqli");
    expect(hit).toMatchObject({ name: "Kadugli", exact: true, score: 1 });
  });

  it("still fuzzy-matches a Latin spelling variant", async () => {
    const hit = await resolve("Tendelti", 0.3);
    expect(hit).toMatchObject({ name: "Tendalti", exact: false });
  });

  it("matches an Arabic name exactly", async () => {
    const hit = await resolve("تندلتي");
    expect(hit).toMatchObject({ name: "Tendalti", exact: true, latitude: 13.12 });
  });

  it("matches Arabic written with vowel marks, tatweel or a Persian letter form", async () => {
    expect(await resolve("كـادُقلي")).toMatchObject({ name: "Kadugli", exact: true });
    expect(await resolve("ربک")).toMatchObject({ name: "Rabak", exact: true });
  });

  it("does not fuzzy-match Arabic", async () => {
    // One letter off كادقلي: Latin would fall through to the trigram tier.
    expect(await resolve("كادقلا", 0.1)).toBeNull();
  });

  describe("withinLocationId", () => {
    it("without it, the more populous same-named place wins", async () => {
      expect(await resolve("Al Abyad")).toMatchObject({ latitude: 13.5 });
    });

    it("keeps only exact matches inside the location", async () => {
      expect(await resolve("Al Abyad", undefined, AREA)).toMatchObject({ latitude: 11.9, exact: true });
      expect(await resolve("الابيض", undefined, AREA)).toMatchObject({ latitude: 11.9, exact: true });
    });

    it("keeps only fuzzy matches inside the location", async () => {
      expect(await resolve("Al Abyadh", 0.3, AREA)).toMatchObject({ latitude: 11.9, exact: false });
    });

    it("returns null when the only match lies outside the location", async () => {
      expect(await resolve("Tendalti", undefined, AREA)).toBeNull();
    });

    it("returns null for an unknown location id", async () => {
      expect(await resolve("Al Abyad", undefined, "no-such-location")).toBeNull();
    });
  });
});
