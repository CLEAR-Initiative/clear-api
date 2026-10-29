/**
 * Retention trim for `activity_logs` (Exponential #1213): clears
 * `ipAddress` and `userAgent` on rows older than 90 days. The rows
 * themselves stay — action counts and per-user history are kept; only
 * the network identifiers age out.
 *
 * Runs in-process on an interval, like the webhook retry worker
 * (src/services/webhook/worker.ts): once shortly after boot, then every
 * 6 hours. Idempotent — a second run in the same window updates nothing.
 * Same single-replica assumption; two replicas would just race to clear
 * the same rows, which is harmless.
 */

import type { PrismaClient } from "../../generated/prisma/client.js";

/** Rows older than this lose their ip / user agent. */
export const ACTIVITY_LOG_PII_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60_000;

/** Clear ip / user agent on rows created before `now - 90 days`.
 *  Returns how many rows were updated. */
export async function trimActivityLogPii(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - ACTIVITY_LOG_PII_RETENTION_DAYS * DAY_MS,
  );
  const result = await prisma.activityLogs.updateMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
    },
    data: { ipAddress: null, userAgent: null },
  });
  return result.count;
}

let timer: ReturnType<typeof setInterval> | null = null;

async function runOnce(prisma: PrismaClient): Promise<void> {
  try {
    const n = await trimActivityLogPii(prisma);
    if (n > 0) console.log(`[activity-log-trim] cleared ip/ua on ${n} rows`);
  } catch (err) {
    console.error("[activity-log-trim] run failed:", err);
  }
}

/** Start the trim schedule. Idempotent — calling twice is a no-op. */
export function startActivityLogTrimWorker(prisma: PrismaClient): void {
  if (timer !== null) return;
  const first = setTimeout(() => void runOnce(prisma), FIRST_RUN_DELAY_MS);
  first.unref?.();
  timer = setInterval(() => void runOnce(prisma), INTERVAL_MS);
  timer.unref?.();
}

/** Stop the schedule (tests / graceful shutdown). */
export function stopActivityLogTrimWorker(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
