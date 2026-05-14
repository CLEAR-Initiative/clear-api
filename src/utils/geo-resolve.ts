import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";

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
 * Create a level-4 point location for an exact lat/lng, parented to the
 * smallest admin polygon that contains the point.
 *
 * NOTE: We deliberately do NOT dedupe against nearby existing A4 rows. Two
 * incidents 200 m apart can sit on opposite sides of a district border, so
 * reusing a nearby A4 would inherit that A4's parent A2 and silently
 * misassign the new incident to the wrong district. Each call resolves its
 * own containing polygon and creates a fresh A4 — accept the row growth in
 * exchange for correct administrative attribution.
 *
 * @param name  Human-readable name (e.g., Dataminr location name or generated)
 * @returns     The created location row
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
