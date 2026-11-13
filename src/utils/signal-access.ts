import { GraphQLError } from "graphql";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type { User } from "../lib/auth.js";

/**
 * Signal visibility for one request.
 *
 * `full`    — every Signal (app users, admins, and the service roles).
 * `restricted` — only Signals whose `sourceId` is in `sourceIds`. An empty
 *               array therefore means NO Signals, which is the default for an
 *               API-only user until an admin grants a source.
 */
export type SignalScope =
  | { kind: "full" }
  | { kind: "restricted"; sourceIds: string[] };

export const FULL_SIGNAL_SCOPE: SignalScope = { kind: "full" };

/** Service roles that read Signals as part of running the platform. */
const SERVICE_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "pipeline",
  "agent",
  "worker",
]);

/**
 * Is this an **API-only** user — a developer onboarded to the API but not to
 * the app?
 *
 * Identified by shape rather than a marker column, because that is what the
 * data already tells us and `createDevUser` issues the same `member` role an
 * app user carries:
 *
 *   role `member`  +  holds a live API key  +  belongs to no organisation
 *                                              AND no team
 *
 * Both memberships must be absent. A `teamMembers` row without the matching
 * `organisationUsers` row is possible through data drift, and this check is
 * allowed to fail only in the safe direction — treating a real app user as
 * API-only would silently cut their Signal access.
 */
async function isApiOnlyUser(prisma: PrismaClient, userId: string): Promise<boolean> {
  const [liveKeys, orgs, teams] = await Promise.all([
    prisma.apiKeys.count({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    }),
    prisma.organisationUsers.count({ where: { userId } }),
    prisma.teamMembers.count({ where: { userId } }),
  ]);
  return liveKeys > 0 && orgs === 0 && teams === 0;
}

/**
 * Resolve the caller's Signal visibility once per request.
 *
 * Called from `createContext`, so every resolver reads a value that has
 * already been decided — no resolver re-derives the policy, and the three
 * membership counts are paid once rather than per Signal field.
 */
export async function resolveSignalScope(
  prisma: PrismaClient,
  user: User | null,
): Promise<SignalScope> {
  if (!user) return FULL_SIGNAL_SCOPE; // unauthenticated never reaches a Signal resolver; requireContentReader rejects first
  const role = user.role ?? "";
  if (SERVICE_ROLES.has(role)) return FULL_SIGNAL_SCOPE;
  if (!(await isApiOnlyUser(prisma, user.id))) return FULL_SIGNAL_SCOPE;

  const grants = await prisma.apiSignalSourceGrant.findMany({
    where: { userId: user.id },
    select: { dataSourceId: true },
  });
  return { kind: "restricted", sourceIds: grants.map((g) => g.dataSourceId) };
}

/**
 * The bare scope fragment. Prefer `withSignalScope` — spreading this next to
 * another filter is unsafe, because a sibling `sourceId` key silently wins
 * whichever is spread last.
 *
 * `{ sourceId: { in: [] } }` matches nothing, so a restricted caller with no
 * grants gets an empty result rather than the whole table — closed by default
 * even on a path nobody thought about.
 */
export function signalScopeWhere(scope: SignalScope): Prisma.signalsWhereInput {
  return scope.kind === "full" ? {} : { sourceId: { in: scope.sourceIds } };
}

/**
 * Combine a Signal filter with the caller's scope so NEITHER can erase the
 * other. Use this for every `prisma.signals` read:
 *
 *   where: withSignalScope(context.signalScope, otherFilters)
 *
 * `AND` rather than object spread, deliberately. Both halves can carry a
 * `sourceId` — `DataSource.signals` sets one from the parent, and
 * `buildSignalsWhere` sets one from a caller-supplied filter — and with a
 * spread the last key written wins. Spreading the scope first would let a
 * caller's own `sourceId` filter widen their access; spreading it last would
 * break the parent-source narrowing. `AND` makes the two independent, so the
 * result is always the intersection.
 */
export function withSignalScope(
  scope: SignalScope,
  where: Prisma.signalsWhereInput,
): Prisma.signalsWhereInput {
  if (scope.kind === "full") return where;
  return { AND: [where, { sourceId: { in: scope.sourceIds } }] };
}

/** Would this already-loaded Signal be visible to the caller? */
export function canReadSignal(
  scope: SignalScope,
  signal: { sourceId: string } | null | undefined,
): boolean {
  if (!signal) return false;
  return scope.kind === "full" || scope.sourceIds.includes(signal.sourceId);
}

/**
 * Guard for the **explicit** Signal entry points (`signals`, `signal`,
 * `signalsByLocation`, and the Signal mutations), where an empty result would
 * read as "there is no data" rather than "you may not see this".
 *
 * Nested fields (`Event.signals`, `DataSource.signals`, …) deliberately do NOT
 * call this: they filter silently, so an Event stays readable and simply
 * carries the Signals the caller is entitled to.
 */
export function assertSignalReadable(scope: SignalScope): void {
  if (scope.kind === "restricted" && scope.sourceIds.length === 0) {
    throw new GraphQLError(
      "Your API access does not include Signals. Ask an administrator to grant the data sources you need.",
      { extensions: { code: "FORBIDDEN", subCode: "NO_SIGNAL_SOURCE_GRANT" } },
    );
  }
}
