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
      /** ISO-2 codes of the countries (level 0) inside `locationIds`. A row
       *  with no state belongs to a country, so only a team that covers the
       *  whole country works it. */
      countryCodes: ReadonlySet<string>;
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
  const countries = await context.prisma.locations.findMany({
    where: { id: { in: [...locationIds] }, level: 0, pCode: { not: null } },
    select: { pCode: true },
  });
  const countryCodes = new Set(countries.map((c) => (c.pCode ?? "").toUpperCase()));
  return { user, scope: { kind: "area", locationIds, countryCodes } };
}

/** Whether a row (or an alias: pass its scope as the state) is in the scope. */
export function placeNameInScope(
  scope: PlaceNameScope,
  row: { stateLocationId: string | null; countryCode: string },
): boolean {
  if (scope.kind === "all") return true;
  return row.stateLocationId
    ? scope.locationIds.has(row.stateLocationId)
    : scope.countryCodes.has(row.countryCode.toUpperCase());
}
