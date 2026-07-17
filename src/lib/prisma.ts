import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    // Interactive transactions default to a 5s timeout. The knowledge-base
    // chunk upsert (a DELETE + up to KB_MAX_CHUNKS_PER_REPORT serial
    // INSERTs) and the situation-analysis upsert both blow past it under
    // the DB contention of a full pipeline run. Raise the default so a
    // busy write doesn't fail a whole report/country; a genuinely stuck
    // transaction still aborts, just later. maxWait covers a saturated
    // connection pool at transaction start.
    transactionOptions: { maxWait: 15_000, timeout: 60_000 },
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
