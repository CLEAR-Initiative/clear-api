/**
 * Durable translation enqueue — the Dagster-side replacement for the
 * Celery broker buffer (`services/celery.ts#bufferTranslationRequest`).
 *
 * When a read discovers an entity has no translation for the active
 * locale, resolvers call `enqueueTranslationDurable` to drop a row into
 * the `translation_queue` table. A Dagster sensor drains that table,
 * translates, upserts the `translations` row, and deletes the queue row
 * (see `translation.resolver.ts#pendingTranslations` / `upsertTranslations`).
 *
 * This is fire-and-forget: the caller's current request always returns
 * canonical English immediately and is never blocked on the write. The
 * upsert is idempotent on (entityType, entityId, locale) — a re-enqueue
 * keeps the original `enqueuedAt`, so bursts collapse to one row.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { DEFAULT_LOCALE } from "../utils/locales.js";

/**
 * In-process dedup gate. The read path can surface the same
 * (entityType, entityId, locale) miss many times in a short window
 * (a list view, concurrent requests). The DB upsert is already
 * idempotent, but a Set skips the redundant round-trips entirely.
 * Entries expire after TTL so a re-enqueue after a genuine
 * source-text change (which the pipeline detects via source hashes)
 * still gets through on the next window.
 */
const recentlyEnqueued = new Map<string, number>();
const DEDUP_TTL_MS = 10_000;

function shouldEnqueue(key: string): boolean {
  const now = Date.now();
  const seenAt = recentlyEnqueued.get(key);
  if (seenAt != null && now - seenAt < DEDUP_TTL_MS) return false;
  recentlyEnqueued.set(key, now);
  // Opportunistic sweep so the map can't grow without bound on a
  // long-lived process. Cheap: only runs when the map gets sizeable.
  if (recentlyEnqueued.size > 1000) {
    for (const [k, t] of recentlyEnqueued) {
      if (now - t >= DEDUP_TTL_MS) recentlyEnqueued.delete(k);
    }
  }
  return true;
}

/**
 * Enqueue an entity for (re)translation at a locale. Fire-and-forget:
 * returns synchronously; the DB write runs in the background. Skips the
 * canonical locale (`en` is never translated). Swallows errors — a
 * failed enqueue only means the entity stays English until the next read.
 */
export function enqueueTranslationDurable(
  prisma: PrismaClient,
  entityType: string,
  entityId: string,
  locale: string,
): void {
  if (locale === DEFAULT_LOCALE) return; // 'en' is canonical, never queued
  const key = `${entityType}:${entityId}:${locale}`;
  if (!shouldEnqueue(key)) return;

  void prisma.translationQueue
    .upsert({
      where: {
        entityType_entityId_locale: { entityType, entityId, locale },
      },
      create: { entityType, entityId, locale },
      update: {}, // idempotent — keep the original enqueuedAt
    })
    .catch((err: unknown) => {
      // Drop the dedup entry so a later read can retry the enqueue.
      recentlyEnqueued.delete(key);
      console.warn(
        `[translation-queue] enqueue failed for ${key}:`,
        err instanceof Error ? err.message : err,
      );
    });
}
