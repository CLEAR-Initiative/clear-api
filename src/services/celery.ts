/**
 * Publish Celery tasks directly to Redis broker.
 *
 * Implements the Celery v2 message protocol matching kombu's
 * Redis transport so Python Celery workers can pick up tasks.
 *
 * The body is a plain JSON string (utf-8), NOT base64.
 * kombu's Redis transport uses json.dumps on the entire message dict,
 * with the body already as a JSON string inside it.
 */

import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

let _redis: RedisClientType | null = null;
let _connecting = false;

async function getRedis(): Promise<RedisClientType> {
  if (_redis?.isReady) return _redis;

  if (_connecting) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (_redis?.isReady) return _redis;
  }

  _connecting = true;
  const { env } = await import("../utils/env.js");
  const url = env.CELERY_BROKER_URL;
  _redis = createClient({ url }) as RedisClientType;
  _redis.on("error", (err) => console.error("[celery-redis] Redis error:", err));
  await _redis.connect();
  _connecting = false;
  return _redis;
}

/**
 * Send a Celery task to the Redis broker.
 *
 * Uses kwargs-only calling convention matching kombu's
 * prepare_message + Redis transport format.
 */
export async function sendCeleryTask(
  taskName: string,
  kwargs: Record<string, unknown>,
  queue = "celery",
): Promise<string> {
  const redis = await getRedis();
  const taskId = randomUUID();

  // Celery v2 body: [args, kwargs, embed]
  const body = JSON.stringify([
    [],
    kwargs,
    { callbacks: null, errbacks: null, chain: null, chord: null },
  ]);

  const message = {
    body,
    "content-encoding": "utf-8",
    "content-type": "application/json",
    headers: {
      lang: "py",
      task: taskName,
      id: taskId,
      shadow: null,
      eta: null,
      expires: null,
      group: null,
      group_index: null,
      retries: 0,
      timelimit: [null, null],
      root_id: taskId,
      parent_id: null,
      argsrepr: "()",
      kwargsrepr: JSON.stringify(kwargs).slice(0, 200),
      origin: "clear-api@node",
      ignore_result: false,
      replaced_task_nesting: 0,
      stamped_headers: null,
      stamps: {},
    },
    properties: {
      correlation_id: taskId,
      reply_to: "",
      delivery_mode: 2,
      delivery_info: {
        exchange: "",
        routing_key: queue,
      },
      priority: 0,
      delivery_tag: randomUUID(),
    },
  };

  // kombu Redis transport: LPUSH queue JSON.dumps(message)
  await redis.lPush(queue, JSON.stringify(message));

  // Include kwargs in the log so a burst is debuggable — repeated bursts
  // of the same (entity_type, entity_id) point at the pipeline failing to
  // persist translations; bursts of distinct ids are just a cold list view.
  console.log(
    `[celery] ${taskName} queued: ${taskId} ${JSON.stringify(kwargs)}`,
  );
  return taskId;
}

/**
 * Cross-request enqueue dedup gate backed by Redis SET NX EX.
 *
 * Returns true when this caller "won" the key (and therefore should
 * proceed to enqueue), false when another caller already reserved
 * the same key within the TTL window.
 *
 * Fail-open on Redis errors: if the broker is unreachable we return
 * true so the caller still attempts to enqueue. Over-enqueuing is
 * cheap (Celery task is idempotent via staleness diff), silently
 * never enqueuing is not.
 *
 * Used by the lazy-on-read translation enqueue in context.ts to
 * collapse the burst of identical translate_entity_task messages
 * we'd otherwise produce when several concurrent requests touch the
 * same untranslated entity.
 */
export async function tryReserveDedupKey(
  key: string,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    const redis = await getRedis();
    const res = await redis.set(key, "1", { NX: true, EX: ttlSeconds });
    return res === "OK";
  } catch (err) {
    console.warn(
      `[celery-dedup] reserve failed for ${key}, failing open:`,
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

// ─── Batched translation enqueue ────────────────────────────────────────────
// At non-English locales the translation-loader's `onMissing` hook used
// to fire one fire-and-forget IIFE per (entityType, entityId) miss,
// each doing `SET NX EX` + `LPUSH` against the broker. A single
// /detection load can produce 100+ misses (deep-nested signal
// locations), so the broker took 200+ Redis round-trips per request —
// through the SSH tunnel that's serializing-painful, and the pile of
// pending microtasks starves the main response's serialization.
//
// This buffer collapses all misses produced inside a FLUSH_INTERVAL_MS
// window across all requests on this process into ONE Celery task
// carrying the accumulated list. Pipeline's translate_entities_batch_task
// then fans out internally with per-item error isolation.
//
// Dedup is per-key within the buffer (same entity in two concurrent
// requests = one buffer entry). The worker's staleness-diff still makes
// repeats across flush windows idempotent — and now they're rare anyway.

interface BufferedItem {
  entityType: string;
  entityId: string;
}

const translationBuffer = new Map<string, BufferedItem>();
let translationFlushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 500;

export function bufferTranslationRequest(
  entityType: string,
  entityId: string,
): void {
  const key = `${entityType}:${entityId}`;
  if (translationBuffer.has(key)) return;
  translationBuffer.set(key, { entityType, entityId });
  if (translationFlushTimer === null) {
    translationFlushTimer = setTimeout(() => {
      void flushTranslationBuffer();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the Node process alive just for the flush timer.
    translationFlushTimer.unref?.();
  }
}

async function flushTranslationBuffer(): Promise<void> {
  translationFlushTimer = null;
  if (translationBuffer.size === 0) return;

  const items = Array.from(translationBuffer.values());
  translationBuffer.clear();

  try {
    await sendCeleryTask("src.tasks.translate.translate_entities_batch_task", {
      items: items.map(({ entityType, entityId }) => ({
        entity_type: entityType,
        entity_id: entityId,
      })),
    });
    console.log(
      `[translate-enqueue] batch flushed: ${items.length} item(s)`,
    );
  } catch (err) {
    console.warn(
      "[translate-enqueue] batch flush failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
