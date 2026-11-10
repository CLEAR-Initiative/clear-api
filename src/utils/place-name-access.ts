import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { TEAM_ADMIN_ROLE, isPlatformAdmin, requireNonWorkerContentReader } from "./auth-guard.js";
import { getTeamScopeLocationIds } from "./location-scope.js";

/**
 * Who works the unresolved place-name queue and the alias list (ADR-0019):
 * the people who decide Location challenges. A platform admin works every
 * row. A team admin works the rows inside the areas of the teams they
 * administer.
 */
export type PlaceNameScope =
  | { kind: "all" }
  | {
      kind: "area";
      /** The teams' scope locations and everything under them. */
      locationIds: ReadonlySet<string>;
    };

/**
 * The caller as a place-name decider, with the rows they may work.
 * FORBIDDEN for a worker, a pending user, a service role and a user who
 * administers no team.
 */
export async function requirePlaceNameDecider(
  context: Context,
): Promise<{ user: NonNullable<Context["user"]>; scope: PlaceNameScope }> {
  const user = requireNonWorkerContentReader(context);
  if (isPlatformAdmin(user)) return { user, scope: { kind: "all" } };

  const teams = await context.prisma.teamMembers.findMany({
    where: { userId: user.id, role: TEAM_ADMIN_ROLE },
    select: { teamId: true },
  });
  if (teams.length === 0) {
    throw new GraphQLError("Requires a team admin or a platform admin", {
      extensions: { code: "FORBIDDEN" },
    });
  }

  const locationIds = new Set<string>();
  for (const { teamId } of teams) {
    const ids = await getTeamScopeLocationIds(context.prisma, teamId);
    // A team with no scope locations monitors every place.
    if (!ids) return { user, scope: { kind: "all" } };
    for (const id of ids) locationIds.add(id);
  }
  return { user, scope: { kind: "area", locationIds } };
}

/**
 * Whether a queue row is in the scope. A row with a state is in the area
 * when its state is. A row with no state belongs to its country, so only a
 * team that covers the whole country works it. The country is a location id,
 * not an ISO code: a country location does not always carry its code.
 */
export function placeNameInScope(
  scope: PlaceNameScope,
  row: { stateLocationId: string | null; countryLocationId: string | null },
): boolean {
  if (scope.kind === "all") return true;
  const place = row.stateLocationId ?? row.countryLocationId;
  return place != null && scope.locationIds.has(place);
}
