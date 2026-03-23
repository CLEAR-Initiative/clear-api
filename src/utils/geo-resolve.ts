import type { PrismaClient } from "../generated/prisma/client.js";

interface ResolvedLocation {
  id: string;
  name: string;
  level: number;
}

/**
 * Resolve a lat/lng point to the most granular location in the hierarchy
 * using PostGIS ST_Contains. Returns the location with the highest level
 * (most specific — district > state > country).
 */
export async function resolveLatLngToLocation(
  prisma: PrismaClient,
  lat: number,
  lng: number,
): Promise<ResolvedLocation | null> {
  const rows = await prisma.$queryRaw<ResolvedLocation[]>`
    SELECT id, name, level
    FROM "locations"
    WHERE ST_Contains("geometry"::geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
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
