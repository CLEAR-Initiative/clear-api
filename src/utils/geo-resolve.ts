import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";

interface ResolvedLocation {
  id: string;
  name: string;
  level: number;
}

/**
 * Resolve a lat/lng point to the most granular existing location in the hierarchy.
 * Returns the best match (district > state > country) without creating new entries.
 */
export async function resolveLatLngToLocation(
  prisma: PrismaClient,
  lat: number,
  lng: number,
): Promise<ResolvedLocation | null> {
  // Phase 1: Find polygon that contains the point (state/country level)
  const containRows = await prisma.$queryRaw<ResolvedLocation[]>`
    SELECT id, name, level
    FROM "locations"
    WHERE "geometry" IS NOT NULL
      AND ST_Contains("geometry"::geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    ORDER BY level DESC
    LIMIT 1
  `;
  if (containRows.length > 0) return containRows[0]!;

  // Phase 2: Find nearest point location within 50km (district level)
  const nearbyRows = await prisma.$queryRaw<ResolvedLocation[]>`
    SELECT id, name, level
    FROM "locations"
    WHERE "geometry" IS NOT NULL
      AND ST_DWithin("geometry", ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, 50000)
    ORDER BY level DESC, ST_Distance("geometry", ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) ASC
    LIMIT 1
  `;
  return nearbyRows[0] ?? null;
}

/**
 * Create a level-4 point location for an exact lat/lng, parented to the
 * nearest resolved district/state. If an existing level-4 point is within
 * 500m, reuse it instead of creating a duplicate.
 *
 * @param name  Human-readable name (e.g., Dataminr location name or generated)
 * @returns     The created or reused location row
 */
export async function createPointLocation(
  prisma: PrismaClient,
  lat: number,
  lng: number,
  name?: string,
): Promise<ResolvedLocation> {
  // Check for an existing level-4 point within 500m to avoid duplicates
  const existing = await prisma.$queryRaw<ResolvedLocation[]>`
    SELECT id, name, level
    FROM "locations"
    WHERE level = 4
      AND "geometry" IS NOT NULL
      AND ST_DWithin("geometry", ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, 500)
    ORDER BY ST_Distance("geometry", ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) ASC
    LIMIT 1
  `;
  if (existing.length > 0) return existing[0]!;

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
 * Create a level-4 region location from multiple signal points.
 * Uses ST_ConvexHull to build a polygon around the points, or a single point
 * if there's only one. Parented to the most common parent among the points.
 */
export async function createRegionFromPoints(
  prisma: PrismaClient,
  points: Array<{ lat: number; lng: number }>,
  name?: string,
): Promise<ResolvedLocation> {
  if (points.length === 0) {
    throw new Error("Cannot create region from zero points");
  }

  // Single point — delegate to createPointLocation
  if (points.length === 1) {
    return createPointLocation(prisma, points[0]!.lat, points[0]!.lng, name);
  }

  // Build a convex hull from the points
  const pointsWkt = points.map((p) => `${p.lng} ${p.lat}`).join(",");
  const multipointWkt = "MULTIPOINT(" + pointsWkt + ")";

  // Find the best parent by resolving the centroid
  const avgLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const avgLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  const parent = await resolveLatLngToLocation(prisma, avgLat, avgLng);
  const parentId = parent?.id ?? null;

  const ancestorIds = parentId ? await computeAncestorIds(prisma, parentId) : [];

  const id = randomUUID();
  const regionName = name ?? `Region ${avgLat.toFixed(2)}, ${avgLng.toFixed(2)}`;

  // Find the nearest state-level (level 1) polygon to clip the region against
  // Walk up ancestors to find a state, or use the parent directly if it's a state
  let clipLocationId: string | null = null;
  if (parent && parent.level <= 1) {
    clipLocationId = parent.id;
  } else if (parentId) {
    // Parent is a district (level 2+), find the state ancestor
    for (const aid of ancestorIds) {
      const ancestor = await prisma.locations.findUnique({
        where: { id: aid },
        select: { id: true, level: true },
      });
      if (ancestor && ancestor.level === 1) {
        clipLocationId = ancestor.id;
        break;
      }
    }
  }

  if (clipLocationId) {
    // Clip the convex hull to the state boundary using ST_Intersection
    await prisma.$executeRaw`
      INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      SELECT
        ${id}, ${regionName}, 4, ${parentId}, ${ancestorIds}::text[],
        ST_Intersection(
          ST_ConvexHull(ST_GeomFromText(${multipointWkt}, 4326)),
          "geometry"::geometry
        )
      FROM "locations"
      WHERE id = ${clipLocationId}
        AND "geometry" IS NOT NULL
    `;
  } else {
    // No state boundary to clip against — use raw convex hull
    await prisma.$executeRaw`
      INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (
        ${id}, ${regionName}, 4, ${parentId}, ${ancestorIds},
        ST_ConvexHull(ST_GeomFromText(${multipointWkt}, 4326))
      )
    `;
  }

  console.log(`[createRegionFromPoints] Created "${regionName}" (level 4, ${points.length} points, clipped=${!!clipLocationId}) → parent: ${parent?.name ?? "none"}`);

  return { id, name: regionName, level: 4 };
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
