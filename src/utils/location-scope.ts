import type { PrismaClient } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * Expand a set of location IDs to include all descendant locations
 * using the location hierarchy (parent → children).
 * Returns the original IDs plus all children, grandchildren, etc.
 */
export async function getExpandedLocationIds(
  prisma: PrismaClient,
  scopeLocationIds: string[],
): Promise<string[]> {
  if (scopeLocationIds.length === 0) return [];

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT id FROM locations WHERE id = ANY(${scopeLocationIds}::text[])
      UNION ALL
      SELECT c.id FROM locations c JOIN tree t ON c.parent_id = t.id
    )
    SELECT id FROM tree
  `;
  return rows.map((r) => r.id);
}

/**
 * Build a Prisma where clause that filters signals by a team's location scope.
 * Looks up the team's locations, expands the hierarchy, and returns the filter.
 * Returns undefined if the team has no locations (global monitoring).
 */
export async function buildLocationFilterForTeam(
  prisma: PrismaClient,
  teamId: string,
): Promise<Prisma.signalsWhereInput | undefined> {
  const teamLocations = await prisma.teamLocations.findMany({
    where: { teamId },
    select: { locationId: true },
  });

  const locationIds = teamLocations.map((tl) => tl.locationId);

  // Team with no locations = global monitoring (no filter)
  if (locationIds.length === 0) return undefined;

  const expandedIds = await getExpandedLocationIds(prisma, locationIds);

  return {
    OR: [
      { originId: { in: expandedIds } },
      { destinationId: { in: expandedIds } },
      { locationId: { in: expandedIds } },
    ],
  };
}

/**
 * Same filter shape, typed for the events model.
 */
export async function buildEventLocationFilterForTeam(
  prisma: PrismaClient,
  teamId: string,
): Promise<Prisma.eventsWhereInput | undefined> {
  return buildLocationFilterForTeam(prisma, teamId) as Promise<
    Prisma.eventsWhereInput | undefined
  >;
}
