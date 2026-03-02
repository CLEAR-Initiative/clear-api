import type { ExpressContextFunctionArgument } from "@as-integrations/express5";
import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma } from "./lib/prisma.js";
import { auth, type Session, type User } from "./lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";

export interface Context {
  prisma: PrismaClient;
  user: User | null;
  session: Session | null;
}

export async function createContext(
  args: ExpressContextFunctionArgument,
): Promise<Context> {
  let user: User | null = null;
  let session: Session | null = null;

  try {
    const result = await auth.api.getSession({
      headers: fromNodeHeaders(args.req.headers),
    });
    if (result) {
      user = result.user;
      session = result.session;
    }
  } catch {
    // Treat as unauthenticated
  }

  return { prisma, user, session };
}
