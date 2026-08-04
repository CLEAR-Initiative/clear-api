/**
 * Enqueue the clear-pipeline classification task for a ground source.
 *
 * PIPELINE CONTRACT (WhatsApp Signal Pipeline, V2 — built in parallel
 * with the clear-pipeline side): after any successful ingest into the
 * ground staging tier (export upload OR live gateway batch), clear-api
 * enqueues `classify_ground_messages(ground_source_id)`. The worker then
 * reads back through the pipeline-facing GraphQL surface
 * (groundMessagesForClassification / upsertGroundMessageClassifications /
 * upsertGroundThreads — see resolvers/ground.resolver.ts) and writes
 * labels + real incident threads.
 *
 * Fire-and-forget, same as the signal-processing enqueue in
 * signal.resolver.ts: a broker hiccup must never fail the ingest that
 * triggered it — the task is idempotent (it re-reads current state), so
 * the next ingest simply re-enqueues.
 */

import { sendCeleryTask } from "./celery.js";

/** Celery task path, matching the repo's existing task-name convention
 * ("src.tasks.process.process_manual_signal", "src.tasks.crisis.…"). */
export const GROUND_CLASSIFY_TASK = "src.tasks.ground.classify_ground_messages";

export function enqueueGroundClassification(groundSourceId: string): void {
  void sendCeleryTask(GROUND_CLASSIFY_TASK, { ground_source_id: groundSourceId }).catch(
    (err) => {
      console.warn(
        `[ground-classify] enqueue failed for ${groundSourceId}:`,
        err instanceof Error ? err.message : err,
      );
    },
  );
}
