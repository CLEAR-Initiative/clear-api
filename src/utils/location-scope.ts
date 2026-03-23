import type { PrismaClient } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { getLocationIdsWithDescendants } from "./geo-resolve.js";

/**
 * Build a Prisma where clause that filters signals by a team's location scope.
 * Looks up the team's locations, expands the hierarchy using ancestorIds,
 * and returns the filter.
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

  // Expand each scope location to include all descendants
  const allIds = new Set<string>();
  for (const locId of locationIds) {
    const expanded = await getLocationIdsWithDescendants(prisma, locId);
    for (const id of expanded) allIds.add(id);
  }

  const expandedIds = [...allIds];

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
