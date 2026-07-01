import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { PrismaClient } from "../generated/prisma/client.js";

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

/** Check global user.role (admin, viewer). Use for platform-wide operations. */
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
 * Approved-tier gate. Admits `admin`, `analyst`, and `viewer`; rejects
 * `pending` (the default for fresh signups) and any other unrecognised
 * role.
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
  "analyst",
  "viewer",
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
