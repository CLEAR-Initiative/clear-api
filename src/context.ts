import type { ExpressContextFunctionArgument } from "@as-integrations/express5";
import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma } from "./lib/prisma.js";
import { auth, type Session, type User } from "./lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";
import { hashKey } from "./utils/api-key.js";

export interface Context {
  prisma: PrismaClient;
  user: User | null;
  session: Session | null;
  authMethod: "session" | "api-key" | null;
}

export async function createContext(
  args: ExpressContextFunctionArgument,
): Promise<Context> {
  let user: User | null = null;
  let session: Session | null = null;
  let authMethod: Context["authMethod"] = null;

  // 1. Try cookie-based session (Better Auth)
  try {
    const result = await auth.api.getSession({
      headers: fromNodeHeaders(args.req.headers),
    });
    if (result) {
      user = result.user;
      session = result.session;
      authMethod = "session";
    }
  } catch {
    // Treat as unauthenticated — fall through to API key check
  }

  // 2. If no session, try Bearer token (API key)
  if (!user) {
    const authHeader = args.req.headers.authorization;
    if (
      typeof authHeader === "string" &&
      authHeader.startsWith("Bearer sk_live_")
    ) {
      const token = authHeader.slice(7); // Remove "Bearer " prefix
      try {
        const keyHash = hashKey(token);
        const apiKey = await prisma.apiKey.findUnique({
          where: { keyHash },
          include: { user: true },
        });

        if (
          apiKey &&
          !apiKey.revokedAt &&
          (!apiKey.expiresAt || apiKey.expiresAt > new Date())
        ) {
          user = apiKey.user as User;
          authMethod = "api-key";

          // Fire-and-forget: update lastUsedAt
          prisma.apiKey
            .update({
              where: { id: apiKey.id },
              data: { lastUsedAt: new Date() },
            })
            .catch(() => {});
        }
      } catch {
        // Treat as unauthenticated
      }
    }
  }

  return { prisma, user, session, authMethod };
}
