import { GraphQLError } from "graphql";
import type { PrismaClient } from "../generated/prisma/client.js";
import { env } from "./env.js";

/** Start of the current UTC day: the window the per-requester cap counts
 *  over (same anchor as the daily Agent budget). */
export function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The per-requester daily cap (`TASK_REQUEST_DAILY_CAP`, ADR-0010), enforced
 * and not merely reported, because API callers will not self-limit. Counts
 * the REQUESTS this requester made since UTC midnight, of every kind, whatever
 * became of them: the Tasks of one request share a `requestId`. Call it after
 * the dedupe: handing back an open Task costs nothing.
 */
export async function assertUnderDailyRequestCap(
  prisma: PrismaClient,
  requesterId: string,
  what = "enrichment request",
): Promise<void> {
  const cap = env.TASK_REQUEST_DAILY_CAP;
  const today = await prisma.task.groupBy({
    by: ["requestId"],
    where: { requesterId, createdAt: { gte: utcMidnight(new Date()) } },
  });
  if (today.length >= cap) {
    throw new GraphQLError(
      `Daily ${what} cap reached: ${cap} requests per day. Try again after 00:00 UTC.`,
      { extensions: { code: "FORBIDDEN", subCode: "DAILY_CAP" } },
    );
  }
}
