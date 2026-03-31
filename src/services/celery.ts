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

  console.log(`[celery] Task ${taskName} queued: ${taskId}`);
  return taskId;
}
