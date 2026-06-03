import type { ExpressContextFunctionArgument } from "@as-integrations/express5";
import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma } from "./lib/prisma.js";
import type { Session, User } from "./lib/auth.js";
import { resolveRequestAuth, type AuthMethod } from "./utils/request-auth.js";

export interface Context {
  prisma: PrismaClient;
  user: User | null;
  session: Session | null;
  authMethod: AuthMethod;
}

export async function createContext(
  args: ExpressContextFunctionArgument,
): Promise<Context> {
  const { user, session, authMethod } = await resolveRequestAuth(args.req.headers);
  return { prisma, user, session, authMethod };
}
