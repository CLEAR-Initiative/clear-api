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
