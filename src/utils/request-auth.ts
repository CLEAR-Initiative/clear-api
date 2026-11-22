import type { IncomingHttpHeaders } from "node:http";
import * as Sentry from "@sentry/node";
import { fromNodeHeaders } from "better-auth/node";
import { auth, type Session, type User } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { hashKey } from "./api-key.js";

export type AuthMethod = "session" | "api-key" | null;

/** Role of the service user whose key identifies clear-mvp's CLEAR Agent. */
export const AGENT_ROLE = "agent";

/** Header carrying the CLEAR Agent's API key, alongside the user's session. */
export const AGENT_KEY_HEADER = "x-clear-agent-key";

export interface ResolvedAuth {
  user: User | null;
  session: Session | null;
  authMethod: AuthMethod;
  /**
   * The request also carried a valid key of the `agent` service user in
   * `X-Clear-Agent-Key`: it came from clear-mvp's CLEAR Agent. Says nothing
   * about who the end user is; that is still `user`, from the session.
   */
  viaAgent: boolean;
}

/** Which identity lookup failed. */
type AuthLookup = "session" | "api-key" | "agent-key";

const LOOKUP_REPORT_INTERVAL_MS = 60_000;
const lastLookupReport = new Map<AuthLookup, number>();

/**
 * Report a failed identity lookup: the database is down, or the auth library
 * threw.
 *
 * The lookups below treat a failure as "not logged in", so the caller gets
 * the standard `UNAUTHENTICATED` error. That is an expected client error and
 * is not sent to GlitchTip (`sentry.ts`). The real failure must be reported
 * here, or an auth outage looks like nothing happened.
 *
 * At most one report a minute per lookup: in an outage every request fails
 * the same way.
 */
export function reportAuthLookupFailure(err: unknown, lookup: AuthLookup): void {
  const now = Date.now();
  const last = lastLookupReport.get(lookup);
  if (last !== undefined && now - last < LOOKUP_REPORT_INTERVAL_MS) return;
  lastLookupReport.set(lookup, now);
  Sentry.captureException(err, { tags: { stage: "auth-lookup", lookup } });
}

/** Test hook: forget when each lookup was last reported. */
export function resetAuthLookupReports(): void {
  lastLookupReport.clear();
}

type ApiKeyRow = NonNullable<Awaited<ReturnType<typeof findLiveApiKey>>>;

/** A `sk_live_` key's row (with its owner), if it is neither revoked nor expired. */
async function findLiveApiKey(token: string) {
  const apiKey = await prisma.apiKeys.findUnique({
    where: { keyHash: hashKey(token) },
    include: { user: true },
  });
  if (!apiKey || apiKey.revokedAt) return null;
  if (apiKey.expiresAt && apiKey.expiresAt <= new Date()) return null;
  return apiKey;
}

function touchLastUsed(apiKey: ApiKeyRow): void {
  // Fire-and-forget.
  prisma.apiKeys
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
}

/** Whether `X-Clear-Agent-Key` holds a live key of an active `agent` user. */
async function isAgentRequest(headers: IncomingHttpHeaders): Promise<boolean> {
  const token = headers[AGENT_KEY_HEADER];
  if (typeof token !== "string" || !token.startsWith("sk_live_")) return false;
  try {
    const apiKey = await findLiveApiKey(token);
    if (!apiKey) return false;
    if (apiKey.user.role !== AGENT_ROLE || apiKey.user.isActive === false) {
      return false;
    }
    touchLastUsed(apiKey);
    return true;
  } catch (err) {
    reportAuthLookupFailure(err, "agent-key");
    return false;
  }
}

/**
 * Resolve the caller's identity from request headers, trying a Better Auth
 * cookie session first and then a `Bearer sk_live_…` API key, and note
 * whether the request came through the CLEAR Agent (`viaAgent`). Single source of
 * truth shared by the GraphQL context and the REST upload route, so a machine
 * call authenticates identically on both surfaces.
 */
export async function resolveRequestAuth(
  headers: IncomingHttpHeaders,
): Promise<ResolvedAuth> {
  let user: User | null = null;
  let session: Session | null = null;
  let authMethod: AuthMethod = null;

  // 1. Cookie-based session (Better Auth).
  try {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (result) {
      user = result.user;
      session = result.session;
      authMethod = "session";
    }
  } catch (err) {
    // Treat as unauthenticated — fall through to the API key check.
    reportAuthLookupFailure(err, "session");
  }

  // 2. Bearer token (API key).
  if (!user) {
    const authHeader = headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer sk_live_")) {
      const token = authHeader.slice(7); // strip "Bearer "
      try {
        const apiKey = await findLiveApiKey(token);
        if (apiKey) {
          user = apiKey.user as unknown as User;
          authMethod = "api-key";
          touchLastUsed(apiKey);
        }
      } catch (err) {
        // Treat as unauthenticated.
        reportAuthLookupFailure(err, "api-key");
      }
    }
  }

  // 3. Active-account gate. Applies to both auth paths so flipping a user
  //    inactive immediately revokes every session and every API key they
  //    hold — admins don't have to revoke keys individually. Returning
  //    null here means downstream resolvers see the request as
  //    unauthenticated; `requireAuth` will then surface the standard
  //    "You must be logged in" error.
  if (user && user.isActive === false) {
    return { user: null, session: null, authMethod: null, viaAgent: false };
  }

  // 4. CLEAR Agent marker, checked only when there is a user to act for.
  const viaAgent = user ? await isAgentRequest(headers) : false;

  return { user, session, authMethod, viaAgent };
}
