import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { auth, type Session, type User } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { hashKey } from "./api-key.js";

export type AuthMethod = "session" | "api-key" | null;

export interface ResolvedAuth {
  user: User | null;
  session: Session | null;
  authMethod: AuthMethod;
}

/**
 * Resolve the caller's identity from request headers, trying a Better Auth
 * cookie session first and then a `Bearer sk_live_…` API key. Single source of
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
  } catch {
    // Treat as unauthenticated — fall through to the API key check.
  }

  // 2. Bearer token (API key).
  if (!user) {
    const authHeader = headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer sk_live_")) {
      const token = authHeader.slice(7); // strip "Bearer "
      try {
        const keyHash = hashKey(token);
        const apiKey = await prisma.apiKeys.findUnique({
          where: { keyHash },
          include: { user: true },
        });

        if (
          apiKey &&
          !apiKey.revokedAt &&
          (!apiKey.expiresAt || apiKey.expiresAt > new Date())
        ) {
          user = apiKey.user as unknown as User;
          authMethod = "api-key";

          // Fire-and-forget: update lastUsedAt.
          prisma.apiKeys
            .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
            .catch(() => {});
        }
      } catch {
        // Treat as unauthenticated.
      }
    }
  }

  return { user, session, authMethod };
}
