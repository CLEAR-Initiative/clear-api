/**
 * Publish Celery tasks directly to Redis broker.
 * Avoids the need for an HTTP API in the pipeline —
 * the Celery worker picks up tasks from Redis automatically.
 */

import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

let _redis: RedisClientType | null = null;
let _connecting = false;

async function getRedis(): Promise<RedisClientType> {
  if (_redis?.isReady) return _redis;

  if (_connecting) {
    // Wait for in-progress connection
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (_redis?.isReady) return _redis;
  }

  _connecting = true;
  // Import env lazily to avoid circular dependency issues at startup
  const { env } = await import("../utils/env.js");
  const url = env.CELERY_BROKER_URL;
  _redis = createClient({ url }) as RedisClientType;
  _redis.on("error", (err) => console.error("[celery-redis] Redis error:", err));
  await _redis.connect();
  _connecting = false;
  return _redis;
}

/**
 * Send a Celery task to the broker (Redis).
 * The task will be picked up by the next available Celery worker.
 */
export async function sendCeleryTask(
  taskName: string,
  kwargs: Record<string, unknown>,
  queue = "celery",
): Promise<string> {
  const redis = await getRedis();
  const taskId = randomUUID();

  const message = {
    body: JSON.stringify([[], kwargs, { callbacks: null, errbacks: null, chain: null, chord: null }]),
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
      origin: "clear-api",
      ignore_result: false,
      replaced_task_nesting: 0,
      stamped_headers: null,
      stamps: {},
    },
    properties: {
      correlation_id: taskId,
      reply_to: "",
      delivery_mode: 2,
      delivery_info: { exchange: "", routing_key: queue },
      priority: 0,
      body_encoding: "base64",
      delivery_tag: randomUUID(),
    },
  };

  await redis.lPush(queue, JSON.stringify(message));

  return taskId;
}
