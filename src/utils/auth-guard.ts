import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { getTeamScopeLocationIds } from "./location-scope.js";

export function requireAuth(context: Context) {
  if (!context.user) {
    throw new GraphQLError("You must be logged in", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return context.user;
}

/**
 * Global-admin bypass predicate. Every org- or team-scoped permission gate
 * MUST short-circuit on this before consulting membership tables, so a
 * platform admin can act on any org/team without an explicit membership
 * row. Centralised here so future renames of the global admin role
 * (planned: `admin` → `superadmin`) touch exactly one line instead of
 * ~10 scattered `user.role === "admin"` checks.
 */
export function isPlatformAdmin(
  user: { role?: string | null } | null | undefined,
): boolean {
  return user?.role === "admin";
}

/**
 * Team roles allowed to write content (create signals, events, alerts,
 * crises) within their team's scope. Any team membership is sufficient
 * for the create/escalate mutations — the policy is that a global
 * viewer who belongs to a team acts on behalf of that team and can
 * file content on its behalf, regardless of intra-team seniority.
 * (Intra-team seniority still matters for team-admin actions like
 * managing members, which flow through `requireTeamAdminOrOrgAdmin`
 * and remain restricted to `team_admin`.)
 */
export const TEAM_CONTENT_WRITER_ROLES: ReadonlySet<string> = new Set([
  "team_admin",
  "analyst",
  "emergency_response_manager",
  "team_member",
]);

/**
 * Content-write gate for mutations that are either platform-wide (global
 * `admin`) or team-scoped (any team membership acting on behalf of `teamId`).
 *
 * Precedence:
 *   1. Global admin  → allowed unconditionally.
 *   2. `teamId` provided AND caller has any TEAM_CONTENT_WRITER_ROLES
 *      role (currently: any team membership) on it → allowed.
 *   3. Everything else → FORBIDDEN.
 *
 * `analyst` is no longer a global role (it is a TEAM role now), so there is no
 * global-analyst bypass here — a team analyst writes via their membership like
 * any other team role. A global `member` with no team membership, anyone whose
 * only role is `pending`, and the `worker` role (even with a team membership)
 * are rejected. Returns the authenticated user so the caller can attribute
 * activity, and `via` so an audit log can distinguish global from team-scoped
 * writes.
 */
export async function requireTeamContentWriter(
  context: Context,
  teamId?: string | null,
): Promise<{ user: NonNullable<Context["user"]>; via: "global" | "team" }> {
  const user = requireNonWorker(context);
  if (isPlatformAdmin(user)) {
    return { user, via: "global" };
  }
  if (!teamId) {
    throw new GraphQLError("Insufficient permissions", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  const membership = await context.prisma.teamMembers.findUnique({
    where: { teamId_userId: { teamId, userId: user.id } },
    select: { role: true },
  });
  if (!membership || !TEAM_CONTENT_WRITER_ROLES.has(membership.role)) {
    throw new GraphQLError(
      "Requires a team membership on this team, or global admin",
      { extensions: { code: "FORBIDDEN" } },
    );
  }
  return { user, via: "team" };
}

/** The team role carrying the elevated, location-scoped powers formerly held by
 *  the (now removed) global `analyst`: promote alerts, decide tasks / case
 *  proposals, manage team analyses, and act on events / alerts / crises that
 *  fall within the team's location scope. A TEAM value of `teamMembers.role`. */
export const TEAM_ANALYST_ROLE = "analyst";

/**
 * True when the user is a team `analyst` on at least one team whose location
 * scope covers one of `locationIds`. A team with NO location bindings is
 * "global monitoring" (wide-open) — its analysts match any location. Used to
 * scope the former global-analyst powers on events / alerts / crises, which
 * carry locations but no `teamId`.
 */
export async function userIsTeamAnalystForLocations(
  prisma: PrismaClient,
  userId: string,
  locationIds: ReadonlyArray<string | null | undefined>,
): Promise<boolean> {
  const memberships = await prisma.teamMembers.findMany({
    where: { userId, role: TEAM_ANALYST_ROLE },
    select: { teamId: true },
  });
  if (memberships.length === 0) return false;
  const locs = locationIds.filter((x): x is string => Boolean(x));
  for (const m of memberships) {
    const scope = await getTeamScopeLocationIds(prisma, m.teamId);
    if (scope === undefined) return true; // wide-open team → any location
    if (locs.some((id) => scope.includes(id))) return true;
  }
  return false;
}

/**
 * Elevated-action gate for an entity identified by its location(s) — the
 * location-scoped replacement for the old `requireRole(["admin","analyst"])` on
 * events / alerts / crises. Global admin passes unconditionally; otherwise the
 * caller must be a team `analyst` whose team location scope covers one of
 * `entityLocationIds` (see {@link userIsTeamAnalystForLocations}).
 */
export async function requireAdminOrTeamAnalystForLocations(
  context: Context,
  entityLocationIds: ReadonlyArray<string | null | undefined>,
): Promise<NonNullable<Context["user"]>> {
  // requireNonWorkerContentReader admits only approved humans (admin / member) —
  // a `pending` signup or a service role (worker/pipeline/agent) is rejected
  // BEFORE any team-membership lookup, so a pending account that somehow holds a
  // team `analyst` membership cannot reach these elevated writes.
  const user = requireNonWorkerContentReader(context);
  if (isPlatformAdmin(user)) return user;
  if (await userIsTeamAnalystForLocations(context.prisma, user.id, entityLocationIds)) {
    return user;
  }
  throw new GraphQLError(
    "Requires global admin, or a team analyst within the target's location scope",
    { extensions: { code: "FORBIDDEN" } },
  );
}

/**
 * Elevated-action gate for an entity that DOES carry a `teamId` (tasks,
 * analyses). Global admin passes; otherwise the caller must be a team `analyst`
 * on that team. A null `teamId` (platform-owned / system row) is admin-only.
 */
export async function requireAdminOrTeamAnalyst(
  context: Context,
  teamId?: string | null,
): Promise<NonNullable<Context["user"]>> {
  // Approved humans only (admin / member) — pending + service roles rejected
  // before the membership lookup (see requireAdminOrTeamAnalystForLocations).
  const user = requireNonWorkerContentReader(context);
  if (isPlatformAdmin(user)) return user;
  if (teamId) {
    const membership = await context.prisma.teamMembers.findUnique({
      where: { teamId_userId: { teamId, userId: user.id } },
      select: { role: true },
    });
    if (membership?.role === TEAM_ANALYST_ROLE) return user;
  }
  throw new GraphQLError("Requires global admin, or team analyst on this team", {
    extensions: { code: "FORBIDDEN" },
  });
}

/** Check global user.role (admin, member). Use for platform-wide operations. */
export function requireRole(context: Context, roles: string[]) {
  const user = requireAuth(context);
  if (!user.role || !roles.includes(user.role)) {
    throw new GraphQLError("Insufficient permissions", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return user;
}

/**
 * Approved-tier gate. Admits `admin`, `member` and `worker`; rejects
 * `pending` (the default for fresh signups) and any other unrecognised role.
 *
 * `member` is the default human role (formerly `viewer`). `analyst` is no
 * longer a global role — it is a TEAM role — so it is not listed here; a team
 * analyst carries the global `member` role and is admitted as such.
 *
 * `worker` is the narrow service role a Task Worker runs as (ADR-0010):
 * it reads content like any approved user so it can research its Task,
 * and its only writes are the Task mutations on Tasks it holds. This gate
 * admits it, so a mutation must never rely on it alone — use
 * `requireNonWorkerContentReader` for writes. `pipeline` and `agent` are
 * deliberately not here.
 *
 * Use this on every content-read resolver (signals, events, alerts,
 * crises and their by-location / by-id variants). Pending users still
 * need `requireAuth`-only resolvers for the "waiting for approval"
 * screen — specifically `me` and `updateProfile` — so don't replace
 * those.
 *
 * Throws FORBIDDEN with a message the portal UI can render verbatim on
 * the pending-user screen.
 */
const APPROVED_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "member",
  "worker",
]);

export function requireContentReader(context: Context) {
  const user = requireAuth(context);
  if (!user.role || !APPROVED_ROLES.has(user.role)) {
    throw new GraphQLError(
      "Your account is awaiting admin approval. You'll be able to access platform data once an admin has approved you.",
      { extensions: { code: "FORBIDDEN", subCode: "PENDING_APPROVAL" } },
    );
  }
  return user;
}

/** The Task Worker service role (ADR-0010). */
export const WORKER_ROLE = "worker";

function rejectWorker<U extends { role?: string | null }>(user: U): U {
  if (user.role === WORKER_ROLE) {
    throw new GraphQLError("The worker role may only call the Task mutations", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return user;
}

/**
 * `requireAuth` for writes. A Task Worker's key lives in an unattended,
 * prompt-injectable routine, so its write surface is exactly the four Task
 * mutations (claim / heartbeat / complete / fail) — every other mutation a
 * signed-in caller can reach uses this or `requireNonWorkerContentReader`
 * instead of the bare gates. Call it first, before any lookup, so a worker
 * learns nothing about the target. tests/schema/worker-write-scope.test.ts
 * fails any new mutation that lets the worker role through.
 */
export function requireNonWorker(context: Context) {
  return rejectWorker(requireAuth(context));
}

/** `requireContentReader` for writes: approved tier, minus the worker role. */
export function requireNonWorkerContentReader(context: Context) {
  return rejectWorker(requireContentReader(context));
}

/**
 * Look up the user's role in a team. Returns the teamMembers record.
 * Throws FORBIDDEN if the user is not a member (unless they're a global admin).
 */
export async function resolveTeamMembership(
  prisma: PrismaClient,
  userId: string,
  teamId: string,
  userRole?: string | null,
) {
  // Global admins can access any team's data
  if (isPlatformAdmin({ role: userRole })) return null;

  const membership = await prisma.teamMembers.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    throw new GraphQLError("Not a member of this team", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return membership;
}

/** Team role that triages the hotline ("ground intel") inbox. A TEAM role
 *  (a value of `teamMembers.role`), distinct from the global admin/member roles. */
export const EMERGENCY_RESPONSE_MANAGER = "emergency_response_manager";

/** True when the user is an active `emergency_response_manager` on any team. */
export async function isEmergencyResponseManager(
  prisma: PrismaClient,
  userId: string,
): Promise<boolean> {
  const membership = await prisma.teamMembers.findFirst({
    where: { userId, role: EMERGENCY_RESPONSE_MANAGER },
    select: { id: true },
  });
  return membership !== null;
}

/**
 * Ground-intel inbox access gate. Admits a global `admin` (who sees everything)
 * OR an `emergency_response_manager` on any team. Returns the user plus `isErm`
 * so callers can branch review rights — admins keep the per-source
 * `reviewerRoles` policy; an ERM may triage. (Phase 2 will scope an ERM to the
 * hotline numbers their team subscribes to.)
 *
 * `analyst` is no longer a global role and does NOT grant ground-inbox access:
 * ground triage is the ERM's team-scoped job. A team analyst's elevated powers
 * are on events/alerts/crises within their location scope, not the hotline.
 */
export async function requireGroundInboxAccess(
  context: Context,
): Promise<{ user: ReturnType<typeof requireAuth>; isErm: boolean }> {
  const user = requireAuth(context);
  if (isPlatformAdmin(user)) {
    return { user, isErm: false };
  }
  // An ERM carries the global `member` role plus the emergency_response_manager
  // TEAM role. Only check team membership for members — service roles
  // (worker/pipeline/agent) and pending users can't be ERMs and are rejected
  // without a DB lookup (keeps a service-role rejection free of DB touches).
  if (user.role === "member" && (await isEmergencyResponseManager(context.prisma, user.id))) {
    return { user, isErm: true };
  }
  throw new GraphQLError("Insufficient permissions", {
    extensions: { code: "FORBIDDEN" },
  });
}

/**
 * Whether the caller is allowed to see another user's PII (email,
 * phoneNumber, role, isActive) and private relations
 * (notifications, alerts, organisations, teamMemberships, feedbacks,
 * comments, escalations).
 *
 * Visibility model:
 *   - Self                              → full
 *   - Global admin                      → full
 *   - Shares at least one organisation  → PII only (basic profile)
 *   - Everything else                   → no PII
 *
 * Result is cached per-request on the Context to amortise the N
 * lookups a list of users would otherwise trigger (e.g. an org's
 * member list rendering every email cell).
 *
 * The function returns a tri-state because relation guards
 * (notifications etc.) are stricter than PII guards — see
 * canSeeUserPrivate below.
 */
export async function canSeeUserPii(
  context: Context,
  targetUserId: string,
): Promise<boolean> {
  if (!context.user) return false;
  if (context.user.id === targetUserId) return true;
  if (isPlatformAdmin(context.user)) return true;

  const cache = getPiiCache(context);
  const cached = cache.get(targetUserId);
  if (cached !== undefined) return cached.canSeePii;

  // Shares-an-organisation check. teamMembers is implicitly covered
  // because teams belong to organisations. The relation on
  // `organisations` is `users` (organisationUsers join table).
  const shared = await context.prisma.organisationUsers.findFirst({
    where: {
      userId: context.user.id,
      organisation: {
        users: { some: { userId: targetUserId } },
      },
    },
    select: { id: true },
  });
  const canSeePii = Boolean(shared);
  cache.set(targetUserId, { canSeePii, canSeePrivate: false });
  return canSeePii;
}

/**
 * Whether the caller can see another user's *private* relations
 * (notifications, alerts, comments, etc.). Stricter than PII: only
 * self or global admin. Sharing an org doesn't grant you the right
 * to read another member's notification inbox or their full comment
 * history across the platform.
 */
export function canSeeUserPrivate(
  context: Context,
  targetUserId: string,
): boolean {
  if (!context.user) return false;
  if (context.user.id === targetUserId) return true;
  if (isPlatformAdmin(context.user)) return true;
  return false;
}

interface PiiCacheEntry {
  canSeePii: boolean;
  canSeePrivate: boolean;
}
type PiiCache = Map<string, PiiCacheEntry>;
const piiCaches = new WeakMap<object, PiiCache>();

function getPiiCache(context: Context): PiiCache {
  let cache = piiCaches.get(context);
  if (!cache) {
    cache = new Map();
    piiCaches.set(context, cache);
  }
  return cache;
}
