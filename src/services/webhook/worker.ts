/**
 * In-process retry worker for webhook deliveries.
 *
 * Every POLL_INTERVAL_MS, query for `webhook_deliveries` rows whose
 * `nextRetryAt <= now` (and haven't succeeded), advance
 * `attemptNumber`, and hand each row off to `attemptDelivery` in
 * parallel with a small concurrency cap.
 *
 * Design notes:
 *   - Single-replica assumption. clear-api runs one container in dev;
 *     if it ever scales out, we'd need `SELECT ... FOR UPDATE SKIP LOCKED`
 *     around the row-picking so two workers don't grab the same delivery.
 *     Documented but not implemented.
 *   - We advance `attemptNumber` BEFORE calling `attemptDelivery`.
 *     That's the sequence Prisma's transaction boundary supports
 *     cleanly, and it prevents a crashed worker from re-running the
 *     same attempt forever (crashed-mid-attempt looks like "one
 *     attempt failed silently" — which is what an infinite loop
 *     otherwise looks like).
 *   - Failures inside the worker loop (Prisma disconnects, unexpected
 *     exceptions) are caught and logged so the interval keeps firing.
 *     GlitchTip's LoggingIntegration (already wired in clear-pipeline,
 *     will be wired here too) turns worker-side errors into events.
 */

import type { PrismaClient } from "../../generated/prisma/client.js";
import { attemptDelivery } from "./deliver.js";

/** How often to check for due retries. Balances "responsive to due
 *  retries" against "don't hammer postgres for the empty case". 15s
 *  matches the shortest backoff step (1s) closely enough that first
 *  retries fire quickly. */
const POLL_INTERVAL_MS = 15_000;

/** Max concurrent attempts per tick. Keeps blast radius small if a
 *  target URL is slow — we still hit REQUEST_TIMEOUT_MS per call, but
 *  we don't queue up 100 concurrent connections. */
const MAX_CONCURRENCY = 4;

/** Cap rows examined per tick. Beyond this, further deliveries wait
 *  until next tick. Prevents a backlog burst from monopolising a
 *  single tick and blocking retries of newer failures. */
const MAX_ROWS_PER_TICK = 50;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Start the retry poller. Idempotent — calling twice is a no-op.
 * Registered from src/index.ts after Apollo boot; the loop stops
 * automatically when the Node process exits (nothing to unref).
 */
export function startWebhookRetryWorker(prisma: PrismaClient): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void tick(prisma).catch((e) => {
      console.error("[webhook-worker] tick threw:", e);
    });
  }, POLL_INTERVAL_MS);
  // Don't hold the event loop open for this alone — clean shutdown wins.
  timer.unref?.();
  console.log(`[webhook-worker] started (interval=${POLL_INTERVAL_MS}ms)`);
}

/** Exposed for testing; called by the interval otherwise. */
export async function tick(prisma: PrismaClient): Promise<void> {
  if (ticking) return; // never overlap ticks — one poll at a time
  ticking = true;
  try {
    const due = await prisma.webhookDelivery.findMany({
      where: {
        succeededAt: null,
        nextRetryAt: { lte: new Date() },
      },
      orderBy: { nextRetryAt: "asc" },
      take: MAX_ROWS_PER_TICK,
      select: { id: true, attemptNumber: true },
    });

    if (due.length === 0) return;

    // Advance attemptNumber and clear nextRetryAt for each row we're
    // about to process. Doing this in a batch, before we start the
    // fetches, gives us the invariant "if we crash mid-attempt, the
    // next tick won't re-pick this row until the timeout has passed
    // (nextRetryAt=null means don't retry). Failure paths inside
    // attemptDelivery re-set nextRetryAt appropriately."
    await Promise.all(
      due.map((d) =>
        prisma.webhookDelivery.update({
          where: { id: d.id },
          data: {
            attemptNumber: d.attemptNumber + 1,
            nextRetryAt: null,
          },
        }),
      ),
    );

    // Fan out with a small concurrency cap.
    let idx = 0;
    async function runNext(): Promise<void> {
      while (idx < due.length) {
        const row = due[idx++];
        if (!row) return;
        try {
          await attemptDelivery(prisma, row.id);
        } catch (e) {
          console.error(`[webhook-worker] delivery ${row.id} threw:`, e);
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENCY, due.length) }, () =>
        runNext(),
      ),
    );
  } finally {
    ticking = false;
  }
}
