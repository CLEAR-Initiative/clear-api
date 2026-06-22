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

/**
 * Build a crisis-shaped where clause that restricts visible crises to those
 * whose constituent events touch the user's team scope.
 *
 * A crisis is included if **any** of its linked events (via the
 * `eventCrises` join) has an `originId`, `destinationId`, or `locationId`
 * inside the union of the user's team location bindings, expanded to all
 * administrative descendants. The crisis's own `locationId` is **not**
 * used for scoping — the events that constitute the crisis are what
 * determine geographic relevance to the caller.
 *
 * Semantics:
 *   - User has no team memberships → undefined (no filter). Preserves the
 *     existing behaviour for unaffiliated users; tightening this is a
 *     separate policy decision.
 *   - User has at least one team with NO location bindings → undefined.
 *     That team is treated as "open to all locations", so the user can
 *     reach every crisis through it.
 *   - Otherwise → an EXISTS-shaped Prisma filter requiring at least one
 *     linked event whose origin/destination/general location is in the
 *     expanded scope set.
 *
 * Global admins should bypass this helper at the call site.
 */
export async function buildCrisisLocationFilterForUser(
  prisma: PrismaClient,
  userId: string,
): Promise<Prisma.crisesWhereInput | undefined> {
  const memberships = await prisma.teamMembers.findMany({
    where: { userId },
    select: { teamId: true },
  });
  if (memberships.length === 0) return undefined;

  const teamLocations = await prisma.teamLocations.findMany({
    where: { teamId: { in: memberships.map((m) => m.teamId) } },
    select: { teamId: true, locationId: true },
  });

  // Detect "any team has no bindings" — that team is wide-open and the
  // user's effective scope is therefore wide-open.
  const teamsWithBindings = new Set(teamLocations.map((tl) => tl.teamId));
  for (const m of memberships) {
    if (!teamsWithBindings.has(m.teamId)) return undefined;
  }

  // Union all bound locations + descendants. Each location is expanded via
  // ancestor_ids so binding "Sudan L0" matches an event at any inner level
  // (state, district, etc.) within that country.
  const allIds = new Set<string>();
  for (const tl of teamLocations) {
    const expanded = await getLocationIdsWithDescendants(prisma, tl.locationId);
    for (const id of expanded) allIds.add(id);
  }
  if (allIds.size === 0) return undefined;
  const scopeIds = [...allIds];

  return {
    eventCrises: {
      some: {
        event: {
          OR: [
            { originId: { in: scopeIds } },
            { destinationId: { in: scopeIds } },
            { locationId: { in: scopeIds } },
          ],
        },
      },
    },
  };
}
