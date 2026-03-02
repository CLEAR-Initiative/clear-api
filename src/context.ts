import type { ExpressContextFunctionArgument } from "@as-integrations/express5";
import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma } from "./lib/prisma.js";

export interface Context {
  prisma: PrismaClient;
}

export async function createContext(
  _args: ExpressContextFunctionArgument,
): Promise<Context> {
  return { prisma };
}
