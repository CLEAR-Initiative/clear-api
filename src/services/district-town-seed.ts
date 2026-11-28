import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import { normalizeGazetteerName } from "../utils/geonames-normalize.js";
import { computeAncestorIds } from "../utils/geo-resolve.js";
import { countryLocationIdForCode } from "./place-names.js";
import { applyAdminNameAliases, type AliasSeedResult, type PlannedAlias } from "./place-alias-seed.js";

// ─── Town points for districts whose town GeoNames lacks (Exponential #1709) ──
// Many Sudan towns share a name with their district: Al Lait, Um Dafoug, Foro
// Baranga. GeoNames has only the district record (class A) for them, so the
// gazetteer can give the district but never the town (D-0288). This loads each
// town as a level-4 location and its spellings as place aliases scoped to the
// town's state. The gazetteer asks aliases before GeoNames, so a lookup inside
// the state gets the town, not the district record.

/** One town from `scripts/data/sudan-district-towns.json`. */
export interface DistrictTown {
  pCode: string;
  district: string;
  state: string;
  /** "A": GeoNames has no town. "B": GeoNames has it under another spelling. */
  group: "A" | "B";
  town: { name: string; nameAr: string | null; lat: number; lon: number; source: "osm" | "ocha" | "geonames"; ref: string | number };
  spellings: string[];
}

export interface PlannedTown {
  pCode: string;
  districtId: string;
  stateId: string;
  /** The name the town's location gets: the district's, without a state suffix. */
  name: string;
  lat: number;
  lon: number;
  /** The source point lay outside the district, this many km; it moved to the nearest point inside. */
  movedKm: number | null;
  osmId: bigint | null;
  geonamesId: number | null;
  /** An existing level-4 location of that name within 2 km, in the district. */
  existingLocationId: string | null;
  spellings: Array<{ nameNorm: string; nameDisplay: string }>;
  /** Spellings that would replace a country-wide alias inside the state. */
  overrides: Array<{ nameNorm: string; locationName: string }>;
}

export interface SkippedTownSpelling {
  pCode: string;
  spelling: string;
  why: string;
}

export interface DistrictTownPlan {
  countryCode: string;
  countryLocationId: string;
  towns: PlannedTown[];
  skippedTowns: Array<{ pCode: string; district: string; why: string }>;
  skippedSpellings: SkippedTownSpelling[];
}

/** How far outside its district a source point may lie and still be moved in. */
const MAX_MOVE_KM = 3;
/** An existing level-4 location this near, with the same name, is the town. */
const REUSE_KM = 2;

function locationName(district: string): string {
  return district.replace(/\s+-\s+\w+$/, "").trim();
}

function osmNodeId(town: DistrictTown["town"]): bigint | null {
  if (town.source !== "osm") return null;
  const m = /^node\/(\d+)$/.exec(String(town.ref));
  return m ? BigInt(m[1]!) : null;
}

/**
 * Plan the towns and their aliases. Reads only.
 *
 * A town is skipped when CLEAR has no district for its pCode, or when its
 * point lies more than 3 km outside the district. A spelling is skipped when:
 *
 * - GeoNames already has a town (class P) of that spelling in the state: the
 *   gazetteer gives a town today, and an alias would replace it.
 * - An alias already holds the spelling in the state.
 * - Two towns of one state share the spelling.
 */
export async function planDistrictTownAliases(
  prisma: PrismaClient,
  args: { countryCode: string; towns: DistrictTown[] },
): Promise<DistrictTownPlan> {
  const countryCode = args.countryCode.toUpperCase();
  const countryLocationId = await countryLocationIdForCode(prisma, countryCode);
  if (!countryLocationId) throw new Error(`CLEAR has no country location for ${countryCode}.`);

  const skippedTowns: DistrictTownPlan["skippedTowns"] = [];
  const skippedSpellings: SkippedTownSpelling[] = [];
  const towns: PlannedTown[] = [];
  const owners = new Map<string, string>(); // `${stateId}\u0000${norm}` -> pCode

  for (const t of args.towns) {
    const [district] = await prisma.$queryRaw<
      { id: string; parentId: string | null; inside: boolean; km: number; lat: number; lon: number }[]
    >`
      WITH p AS (SELECT ST_SetSRID(ST_MakePoint(${t.town.lon}, ${t.town.lat}), 4326) AS pt)
      SELECT l."id", l."parent_id" AS "parentId",
             ST_Contains(l."geometry", p.pt) AS "inside",
             ST_Distance(l."geometry"::geography, p.pt::geography) / 1000 AS "km",
             ST_Y(q.pt) AS "lat", ST_X(q.pt) AS "lon"
      FROM "locations" l CROSS JOIN p
      CROSS JOIN LATERAL (
        SELECT CASE WHEN ST_Contains(l."geometry", p.pt) THEN p.pt
               -- 200 m inside the edge: a point on the edge is in no district.
               ELSE ST_ClosestPoint(ST_Buffer(l."geometry"::geography, -200)::geometry, p.pt) END AS pt
      ) q
      WHERE l."level" = 2 AND l."p_code" = ${t.pCode} AND ${countryLocationId} = ANY(l."ancestor_ids")
      LIMIT 1`;
    if (!district || !district.parentId) {
      skippedTowns.push({ pCode: t.pCode, district: t.district, why: "CLEAR has no district with this pCode" });
      continue;
    }
    if (!district.inside && district.km > MAX_MOVE_KM) {
      skippedTowns.push({
        pCode: t.pCode, district: t.district,
        why: `the point lies ${district.km.toFixed(1)} km outside the district`,
      });
      continue;
    }
    const name = locationName(t.district);
    const [existing] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "locations"
      WHERE "level" = 4 AND LOWER("name") = LOWER(${name}) AND ${district.id} = ANY("ancestor_ids")
        AND ST_DWithin("geometry"::geography, ST_SetSRID(ST_MakePoint(${district.lon}, ${district.lat}), 4326)::geography, ${REUSE_KM * 1000})
      LIMIT 1`;

    const spellings: PlannedTown["spellings"] = [];
    const overrides: PlannedTown["overrides"] = [];
    for (const display of t.spellings) {
      const nameNorm = normalizeGazetteerName(display);
      if (nameNorm.replace(/ /g, "").length < 3 || spellings.some((s) => s.nameNorm === nameNorm)) continue;
      const key = `${district.parentId}\u0000${nameNorm}`;
      const owner = owners.get(key);
      if (owner && owner !== t.pCode) {
        skippedSpellings.push({ pCode: t.pCode, spelling: display, why: `also a spelling of the town of ${owner} in the same state` });
        continue;
      }
      const [found] = await prisma.$queryRaw<{ townInState: boolean; aliasInState: string | null; countryWide: string | null }[]>`
        SELECT
          EXISTS (
            SELECT 1 FROM "geonames_name" n JOIN "geonames" g ON g."geonames_id" = n."geonames_id"
            WHERE n."name_norm" = ${nameNorm} AND n."country_code" = ${countryCode} AND g."feature_class" = 'P'
              AND ST_Contains((SELECT s."geometry" FROM "locations" s WHERE s."id" = ${district.parentId}),
                              ST_SetSRID(ST_MakePoint(g."longitude", g."latitude"), 4326))
          ) AS "townInState",
          (SELECT a."location_id" FROM "place_aliases" a
            WHERE a."country_code" = ${countryCode} AND a."name_norm" = ${nameNorm} AND a."scope_location_id" = ${district.parentId}
            LIMIT 1) AS "aliasInState",
          (SELECT l."name" FROM "place_aliases" a JOIN "locations" l ON l."id" = a."location_id"
            WHERE a."country_code" = ${countryCode} AND a."name_norm" = ${nameNorm} AND a."scope_location_id" IS NULL
            LIMIT 1) AS "countryWide"`;
      if (found!.townInState) {
        skippedSpellings.push({ pCode: t.pCode, spelling: display, why: "GeoNames has a town of this spelling in the state" });
        continue;
      }
      if (found!.aliasInState && found!.aliasInState !== existing?.id) {
        skippedSpellings.push({ pCode: t.pCode, spelling: display, why: "an alias already holds this spelling in the state" });
        continue;
      }
      if (found!.countryWide) overrides.push({ nameNorm, locationName: found!.countryWide });
      owners.set(key, t.pCode);
      spellings.push({ nameNorm, nameDisplay: display });
    }
    if (spellings.length === 0) {
      skippedTowns.push({ pCode: t.pCode, district: t.district, why: "no spelling is left to alias" });
      continue;
    }
    towns.push({
      pCode: t.pCode, districtId: district.id, stateId: district.parentId, name,
      lat: district.lat, lon: district.lon, movedKm: district.inside ? null : Number(district.km.toFixed(2)),
      osmId: osmNodeId(t.town), geonamesId: t.town.source === "geonames" ? Number(t.town.ref) : null,
      existingLocationId: existing?.id ?? null, spellings, overrides,
    });
  }
  return { countryCode, countryLocationId, towns, skippedTowns, skippedSpellings };
}

export interface DistrictTownResult extends AliasSeedResult {
  locationsCreated: number;
  locationsReused: number;
}

/**
 * Create the town locations (level 4, `point_type = 'seed'`, under the
 * district) and write the aliases with `source = "seed"`, scoped to the
 * state. The aliases close the open queue rows they answer, as
 * `applyAdminNameAliases` does. Safe to run again: a town location that
 * exists (same name, within 2 km, in the district) is reused, and an alias
 * that exists is left as it is. The locations and the aliases are two
 * transactions: a run that fails between them leaves towns with no alias,
 * which the next run reuses.
 */
export async function applyDistrictTownAliases(
  prisma: PrismaClient,
  plan: DistrictTownPlan,
  options: { note: string; now?: Date },
): Promise<DistrictTownResult> {
  let locationsCreated = 0;
  let locationsReused = 0;
  const aliases: PlannedAlias[] = [];
  await prisma.$transaction(async (tx) => {
    for (const t of plan.towns) {
      let locationId = t.existingLocationId;
      if (locationId) {
        locationsReused += 1;
      } else {
        locationId = randomUUID();
        const ancestorIds = await computeAncestorIds(tx as unknown as PrismaClient, t.districtId);
        await tx.$executeRaw`
          INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "point_type", "osm_id", "geonames_id", "geometry")
          VALUES (${locationId}, ${t.name}, 4, ${t.districtId}, ${ancestorIds}::text[], 'seed', ${t.osmId}, ${t.geonamesId},
                  ST_SetSRID(ST_MakePoint(${t.lon}, ${t.lat}), 4326))`;
        locationsCreated += 1;
      }
      for (const s of t.spellings) {
        aliases.push({
          nameNorm: s.nameNorm, nameDisplay: s.nameDisplay, locationId, locationName: t.name, pCode: t.pCode, level: 4,
          scopeLocationId: t.stateId, knownToGeonames: false,
        });
      }
    }
  }, { timeout: 60_000 });
  const result = await applyAdminNameAliases(prisma, { countryCode: plan.countryCode, aliases }, options);
  return { ...result, locationsCreated, locationsReused };
}
