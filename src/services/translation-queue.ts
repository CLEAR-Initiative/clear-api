/**
 * Durable translation enqueue — the Dagster-side replacement for the
 * Celery broker buffer (`services/celery.ts#bufferTranslationRequest`).
 *
 * When a read discovers an entity has no translation for the active locale,
 * resolvers call `enqueueTranslationDurable` to queue a (re)translation. A
 * Dagster sensor drains the `translation_queue` table, translates, upserts the
 * `translations` row, and deletes the queue row (see
 * `translation.resolver.ts#pendingTranslations` / `upsertTranslations`).
 *
 * BATCHED, fire-and-forget. A single list view at a non-English locale can
 * surface 100+ misses (deep-nested signal locations), and at a freshly-enabled
 * locale the miss rate is ~100% because no rows exist yet. Writing one row per
 * miss floods the Prisma connection pool ("timeout exceeded when trying to
 * connect") and takes the whole API down. So misses are collapsed in-process
 * over a short window and flushed as ONE `createMany`, exactly like the Celery
 * buffer this replaced — DB connection use is ~one query per window regardless
 * of miss volume. The caller's request always returns canonical English
 * immediately and never blocks on the write.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { DEFAULT_LOCALE } from "../utils/locales.js";

interface BufferedEnqueue {
  entityType: string;
  entityId: string;
  locale: string;
}

/** Misses accumulated in the current flush window, deduped by (type,id,locale). */
const buffer = new Map<string, BufferedEnqueue>();
/** Keys enqueued in a recent SUCCESSFUL flush — skip re-buffering them until the
 *  TTL lapses, so a sustained 100%-miss locale doesn't re-queue the same rows on
 *  every request. Only set on success, so a failed flush is retried on next read. */
const recentlyQueued = new Map<string, number>();
const DEDUP_TTL_MS = 30_000;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let prismaRef: PrismaClient | null = null;

/** Flush window. One `createMany` fires at most this often per process. */
const FLUSH_INTERVAL_MS = 1_000;
/** Hard cap on the buffer — flush immediately when a burst reaches it so the
 *  buffer can't grow unbounded and a single query stays reasonably sized. */
const MAX_BUFFER = 500;

/**
 * Queue an entity for (re)translation at a locale. Fire-and-forget: returns
 * synchronously; the row is written on the next batched flush. Skips the
 * canonical locale (`en` is never translated) and keys queued very recently.
 */
export function enqueueTranslationDurable(
  prisma: PrismaClient,
  entityType: string,
  entityId: string,
  locale: string,
): void {
  if (locale === DEFAULT_LOCALE) return; // 'en' is canonical, never queued
  prismaRef = prisma;

  const key = `${entityType}:${entityId}:${locale}`;
  const seenAt = recentlyQueued.get(key);
  if (seenAt != null && Date.now() - seenAt < DEDUP_TTL_MS) return;
  if (buffer.has(key)) return;
  buffer.set(key, { entityType, entityId, locale });

  if (buffer.size >= MAX_BUFFER) {
    void flushBuffer();
    return;
  }
  if (flushTimer === null) {
    flushTimer = setTimeout(() => void flushBuffer(), FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for a pending flush.
    flushTimer.unref?.();
  }
}

async function flushBuffer(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const prisma = prismaRef;
  if (!prisma || buffer.size === 0) return;

  const items = Array.from(buffer.values());
  buffer.clear();

  try {
    // One query for the whole window. skipDuplicates makes it idempotent on the
    // (entityType, entityId, locale) unique constraint and preserves the original
    // enqueuedAt on rows already queued.
    await prisma.translationQueue.createMany({ data: items, skipDuplicates: true });

    const now = Date.now();
    for (const it of items) {
      recentlyQueued.set(`${it.entityType}:${it.entityId}:${it.locale}`, now);
    }
    if (recentlyQueued.size > 5_000) {
      for (const [k, t] of recentlyQueued) {
        if (now - t >= DEDUP_TTL_MS) recentlyQueued.delete(k);
      }
    }
  } catch (err: unknown) {
    // Swallowed — the entities stay English until re-queued on a later read. Not
    // marked as recentlyQueued, so they ARE retried next time. One log line for
    // the whole batch, never one per item.
    console.warn(
      `[translation-queue] batch enqueue failed (${items.length} item(s)):`,
      err instanceof Error ? err.message : err,
    );
  }
}
