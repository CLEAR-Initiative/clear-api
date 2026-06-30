import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

interface ResolvedLocation {
  id: string;
  name: string;
  level: number;
}

/**
 * Resolve a lat/lng point to the most granular existing administrative location.
 * Returns the best match (district > state > country) without creating new entries.
 *
 * Excludes level-4 rows from consideration: those are themselves point/region
 * locations (created by createPointLocation / createRegionFromPoints) and must
 * not be eligible as parents. Without this filter, a previous signal at the
 * same coordinates would be picked as the parent (because `ORDER BY level
 * DESC` ranks L4 above A2), producing a parent chain of L4→L4→L4→A1 and
 * polluting ancestorIds for the whole cascade.
 */
export async function resolveLatLngToLocation(
  prisma: PrismaClient,
  lat: number,
  lng: number,
): Promise<ResolvedLocation | null> {
  // Phase 1: smallest admin polygon (A2 > A1 > A0) that contains the point.
  const containRows = await prisma.$queryRaw<ResolvedLocation[]>`
    SELECT id, name, level
    FROM "locations"
    WHERE "geometry" IS NOT NULL
      AND level < 4
      AND ST_Contains("geometry"::geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    ORDER BY level DESC
    LIMIT 1
  `;
  if (containRows.length > 0) return containRows[0]!;

  // Phase 2: nearest admin polygon within 50km (handles points just outside
  // any polygon — coastal/border slivers in OCHA boundary data).
  const nearbyRows = await prisma.$queryRaw<ResolvedLocation[]>`
    SELECT id, name, level
    FROM "locations"
    WHERE "geometry" IS NOT NULL
      AND level < 4
      AND ST_DWithin("geometry", ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, 50000)
    ORDER BY level DESC, ST_Distance("geometry", ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) ASC
    LIMIT 1
  `;
  return nearbyRows[0] ?? null;
}

/**
 * Reuse radius for nearby-A4 dedup. Tight (100 m) to avoid the
 * district-border problem flagged below: two incidents 200 m apart can
 * sit on opposite sides of a district border, so reusing a nearby A4
 * across that boundary would inherit the wrong parent A2 and silently
 * misassign the new incident.
 *
 * Even at 100 m a border crossing is theoretically possible, so the
 * reuse path additionally requires the existing A4's parent_id to
 * match the parent we'd compute for the new point — see
 * `createPointLocation` below.
 */
const A4_REUSE_RADIUS_METERS = 100;

/**
 * Upper bound on name length for a reusable A4. No real place name
 * comes close to this; anything longer is almost certainly a legacy
 * signal-title L4 (created back when the pipeline used the signal
 * headline as the location name). Used by `createPointLocation` to
 * keep new points from inheriting an old headline as their location.
 */
const PLACE_NAME_MAX_CHARS = 80;

/**
 * Create a level-4 point location for an exact lat/lng, parented to the
 * smallest admin polygon that contains the point.
 *
 * Tries to reuse an existing A4 within `A4_REUSE_RADIUS_METERS` first —
 * but only when the candidate's parent_id matches the parent we'd
 * compute for the new point, so a fine-grained district boundary
 * between the two coords still creates a fresh A4 instead of silently
 * inheriting the wrong administrative attribution.
 *
 * @param name  Human-readable name (e.g., geoparser candidate name).
 *              Used only when a fresh row is created — reused rows keep
 *              their original name.
 * @returns     The created or reused location row.
 */
export async function createPointLocation(
  prisma: PrismaClient,
  lat: number,
  lng: number,
  name?: string,
): Promise<ResolvedLocation> {
  // Resolve parent location (most granular existing: district > state > country)
  const parent = await resolveLatLngToLocation(prisma, lat, lng);
  const parentId = parent?.id ?? null;

  // Reuse a nearby A4 if one exists with the same parent. The
  // parent-match check is what makes this safe near administrative
  // borders — without it, the row growth saving would come at the cost
  // of cross-district misassignment.
  //
  // The name-shape filters skip legacy signal-title L4s — rows created
  // back when the pipeline used the signal headline as the location
  // name (e.g. "Labor protest for revised salary […]: Local News Outlet
  // via Radio Dabanga."). Those headline rows sit at the same city
  // centroids new Dataminr signals land on, so without the filter a
  // fresh al-Obeid point silently inherits a leftover headline as its
  // location name. Place names never run >80 chars or carry the
  // "<headline>: <attribution> via <source>" punctuation pattern,
  // making the exclusion both cheap and unambiguous.
  const nearbyReuse = await prisma.$queryRaw<ResolvedLocation[]>`
    SELECT id, name, level
    FROM "locations"
    WHERE level = 4
      AND "parent_id" IS NOT DISTINCT FROM ${parentId}
      AND "geometry" IS NOT NULL
      AND LENGTH(name) <= ${PLACE_NAME_MAX_CHARS}
      AND name NOT LIKE '%: %'
      AND name NOT LIKE '% via %'
      AND ST_DWithin(
            "geometry"::geography,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
            ${A4_REUSE_RADIUS_METERS}
          )
    ORDER BY ST_Distance(
              "geometry"::geography,
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
            ) ASC
    LIMIT 1
  `;
  if (nearbyReuse[0]) {
    const reused = nearbyReuse[0];
    console.log(
      `[createPointLocation] Reused "${reused.name}" (level 4, id=${reused.id}) within ` +
      `${A4_REUSE_RADIUS_METERS}m of (${lat.toFixed(4)}, ${lng.toFixed(4)}) → parent: ${parent?.name ?? "none"}`,
    );
    return reused;
  }

  // Compute ancestor IDs
  const ancestorIds = parentId ? await computeAncestorIds(prisma, parentId) : [];

  const id = randomUUID();
  const locationName = name ?? `Point ${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  await prisma.$executeRaw`
    INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
    VALUES (${id}, ${locationName}, 4, ${parentId}, ${ancestorIds}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
  `;

  console.log(`[createPointLocation] Created "${locationName}" (level 4) → parent: ${parent?.name ?? "none"}`);

  return { id, name: locationName, level: 4 };
}

/**
 * Resolve a set of lat/lng points to the deepest admin polygon that contains
 * all of them. Returns A2 when every point sits in the same district; falls
 * through to A1 when they span multiple A2s in the same state, then A0.
 *
 * This replaces the older `createRegionFromPoints` convex-hull approach for
 * the multi-signal `createEvent` path. Keeping the `locations` table purely
 * administrative avoids both the row-growth problem (every multi-signal
 * event used to insert a new level-4 hull row) and the parent-resolution
 * pollution it caused for new points landing inside those hulls.
 *
 * Returns null when the points have no shared admin ancestor — should not
 * happen for grouped signals in the same country, but the caller must
 * tolerate it (the event simply gets created with no location attached,
 * same as today's behaviour when no signals carry geometry).
 */
export async function resolvePointsToCommonAncestor(
  prisma: PrismaClient,
  points: Array<{ lat: number; lng: number }>,
): Promise<ResolvedLocation | null> {
  if (points.length === 0) return null;
  if (points.length === 1) {
    return resolveLatLngToLocation(prisma, points[0]!.lat, points[0]!.lng);
  }

  // ST_Contains(polygon, MULTIPOINT) is true iff every component point is
  // strictly inside the polygon — exactly the "contains all" semantics we
  // want. ORDER BY level DESC picks the most granular polygon that qualifies.
  const pointsWkt = points.map((p) => `${p.lng} ${p.lat}`).join(",");
  const multipointWkt = `MULTIPOINT(${pointsWkt})`;

  const rows = await prisma.$queryRaw<ResolvedLocation[]>`
    SELECT id, name, level
    FROM "locations"
    WHERE "geometry" IS NOT NULL
      AND level <= 2
      AND ST_Contains(
        "geometry"::geometry,
        ST_GeomFromText(${multipointWkt}, 4326)
      )
    ORDER BY level DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Outcome of the find-or-create flow for a landmark/place L4. */
export type FindOrCreateLandmarkL4Result =
  | {
      locationId: string;
      reused: boolean;
      pointType: string | null;
      abortedReason: null;
    }
  | {
      locationId: null;
      reused: false;
      pointType: null;
      /** "different_a2" — geoparsed candidate and source coord disagree
       *  on the containing A2. Caller should fall back to source coords. */
      abortedReason: "different_a2";
    };

/** Proximity threshold (metres) for reusing an existing non-landmark A4. */
const ADMIN_REUSE_RADIUS_M = 100;

/**
 * Find an existing level-4 location that matches a geoparsed candidate, or
 * create one. Used by the clear-pipeline geoparser path to promote a landmark
 * hit ("Nyala Airport") into a real, reusable A4 row instead of leaving the
 * resolver to invent a fresh point-location every time.
 *
 * Reuse rules (within the same containing A2):
 *   - kind="landmark"  →  case-insensitive exact name match
 *   - kind="admin"     →  any A4 within ADMIN_REUSE_RADIUS_M of the candidate
 *
 * Safety: when source coords are provided, we compare the candidate's
 * containing A2 against the source coord's containing A2. A disagreement
 * means the name is ambiguous across regions (e.g., a "Khartoum Airport"
 * candidate vs a Darfur-coord source) and we abort the promotion so the
 * caller falls back to source coords. If either A2 lookup is null we treat
 * the check as inconclusive and proceed — the geoparser already passed
 * country-code filtering, so the worst case is an A4 in the right country
 * but slightly off in admin attribution.
 *
 * New rows are tagged `point_type = 'landmark-geocoded'` to keep provenance
 * visible to downstream consumers.
 */
export async function findOrCreateLandmarkL4(
  prisma: PrismaClient,
  args: {
    name: string;
    lat: number;
    lng: number;
    kind: "landmark" | "admin";
    sourceLat?: number | null;
    sourceLng?: number | null;
  },
): Promise<FindOrCreateLandmarkL4Result> {
  const { name, lat, lng, kind } = args;

  // Resolve the candidate's smallest containing admin polygon. We need the
  // A2 id specifically for the reuse scope; resolveLatLngToLocation may
  // return A1/A0 if the point is outside any A2.
  const candidateA2 = await resolveContainingA2(prisma, lat, lng);

  // Same-A2 safety check against the source coords, if provided.
  if (args.sourceLat != null && args.sourceLng != null) {
    const sourceA2 = await resolveContainingA2(prisma, args.sourceLat, args.sourceLng);
    if (candidateA2 && sourceA2 && candidateA2 !== sourceA2) {
      return {
        locationId: null,
        reused: false,
        pointType: null,
        abortedReason: "different_a2",
      };
    }
  }

  // Reuse scope: when we know the candidate's A2, restrict the search to
  // A4s whose parent chain contains it. When A2 is unknown (point falls
  // outside any A2 polygon), search country-wide — rare path, and the
  // Nominatim country-code filter already keeps us in the right country.
  if (kind === "landmark") {
    const existing = await prisma.$queryRaw<{ id: string; point_type: string | null }[]>`
      SELECT id, point_type
      FROM "locations"
      WHERE level = 4
        AND LOWER(name) = LOWER(${name})
        ${candidateA2 ? Prisma.sql`AND ${candidateA2} = ANY("ancestor_ids")` : Prisma.empty}
      LIMIT 1
    `;
    if (existing.length > 0) {
      return {
        locationId: existing[0]!.id,
        reused: true,
        pointType: existing[0]!.point_type,
        abortedReason: null,
      };
    }
  } else {
    // Admin reuse: name match (case-insensitive) + proximity (≤100m) + same
    // A2. The name match is what stops legacy signal-title L4s from being
    // reused: those were created with the signal's headline as the name
    // (e.g. "Drone strike on hospital") and happen to sit near city centroids
    // because that's where Dataminr's source coords cluster. Without the
    // name filter, our "Khartoum" candidate would proximity-match any of
    // them and we'd attribute the new signal to a leftover signal-title L4
    // — visually identical to "we never created a city-named L4."
    const existing = await prisma.$queryRaw<{ id: string; point_type: string | null }[]>`
      SELECT id, point_type
      FROM "locations"
      WHERE level = 4
        AND "geometry" IS NOT NULL
        AND LOWER(name) = LOWER(${name})
        AND ST_DWithin(
          "geometry"::geography,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
          ${ADMIN_REUSE_RADIUS_M}
        )
        ${candidateA2 ? Prisma.sql`AND ${candidateA2} = ANY("ancestor_ids")` : Prisma.empty}
      ORDER BY ST_Distance(
        "geometry"::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      ) ASC
      LIMIT 1
    `;
    if (existing.length > 0) {
      return {
        locationId: existing[0]!.id,
        reused: true,
        pointType: existing[0]!.point_type,
        abortedReason: null,
      };
    }
  }

  // No match — create a fresh A4 tagged as landmark-geocoded.
  const parent = await resolveLatLngToLocation(prisma, lat, lng);
  const parentId = parent?.id ?? null;
  const ancestorIds = parentId ? await computeAncestorIds(prisma, parentId) : [];

  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "locations"
      ("id", "name", "level", "parent_id", "ancestor_ids", "point_type", "geometry")
    VALUES (
      ${id}, ${name}, 4, ${parentId}, ${ancestorIds}, 'landmark-geocoded',
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
    )
  `;

  console.log(
    `[findOrCreateLandmarkL4] Created "${name}" (level 4, landmark-geocoded) → parent: ${parent?.name ?? "none"}`,
  );

  return {
    locationId: id,
    reused: false,
    pointType: "landmark-geocoded",
    abortedReason: null,
  };
}

/** Internal: find the level-2 location containing a point, or null. */
async function resolveContainingA2(
  prisma: PrismaClient,
  lat: number,
  lng: number,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "locations"
    WHERE level = 2
      AND "geometry" IS NOT NULL
      AND ST_Contains("geometry"::geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Get all location IDs that are within the given location
 * (the location itself + all descendants), using the ancestorIds array.
 * Much faster than the recursive CTE approach.
 */
export async function getLocationIdsWithDescendants(
  prisma: PrismaClient,
  locationId: string,
): Promise<string[]> {
  // Find all locations where ancestorIds contains the target, plus the target itself
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "locations"
    WHERE id = ${locationId}
       OR ${locationId} = ANY("ancestor_ids")
  `;
  return rows.map((r) => r.id);
}

/**
 * Compute the ancestor IDs for a location by walking up the parent chain.
 * Returns an array ordered from direct parent to root.
 */
export async function computeAncestorIds(
  prisma: PrismaClient,
  parentId: string | null,
): Promise<string[]> {
  if (!parentId) return [];

  const ancestors: string[] = [];
  let currentId: string | null = parentId;

  while (currentId) {
    ancestors.push(currentId);
    const parent: { parentId: string | null } | null = await prisma.locations.findUnique({
      where: { id: currentId },
      select: { parentId: true },
    });
    currentId = parent?.parentId ?? null;
  }

  return ancestors;
}
