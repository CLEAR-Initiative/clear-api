import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  // Pool sizing + a connection-acquire timeout. pg-pool defaults to max 10
  // and NO acquire timeout, so once all 10 connections are checked out (e.g.
  // two pipeline flows writing concurrently) every further query waits on
  // pool.connect() FOREVER — a silent, un-erroring hang with no timeout.
  // Raise the ceiling and fail fast: connectionTimeoutMillis surfaces a
  // saturated pool as a retryable error instead of an indefinite stall.
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    connectionTimeoutMillis: 10_000,
  });
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
