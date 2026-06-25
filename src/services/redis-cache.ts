/**
 * Generic Redis key-value cache for short-lived, non-critical state.
 *
 * Uses the same connection that `celery.ts` already opens to the broker
 * Redis at `CELERY_BROKER_URL` — adding another client just for cache
 * reads would double the connection footprint for no benefit.
 *
 * Every entry written through this module is namespaced with the
 * `cache:` prefix so it can't collide with Celery's task queues. Use
 * the `publicEventCacheKey` helper below for the public-event link
 * keys specifically.
 *
 * Everything here is best-effort. A Redis outage or an evicted key
 * results in a typed `null` from `get` — callers treat that the same
 * as "not found" and degrade gracefully (the public-event resolver
 * returns null which surfaces as "Link expired or not found" on the
 * frontend).
 */

import { createClient, type RedisClientType } from "redis";
import { env } from "../utils/env.js";

let _redis: RedisClientType | null = null;
let _connecting = false;

/**
 * Lazy-connect to Redis on first use. Re-used across calls in the same
 * process. Treat as best-effort: if the connection fails we surface the
 * error to the caller so the public mutation can return an error and
 * the public query degrades to null.
 */
async function getRedis(): Promise<RedisClientType> {
  if (_redis?.isReady) return _redis;
  if (_connecting) {
    // Tiny back-off so a second concurrent caller doesn't spin up a
    // duplicate connection while the first one is still negotiating.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (_redis?.isReady) return _redis;
  }
  _connecting = true;
  _redis = createClient({ url: env.CELERY_BROKER_URL }) as RedisClientType;
  _redis.on("error", (err) =>
    console.error("[redis-cache] redis error:", err instanceof Error ? err.message : err),
  );
  await _redis.connect();
  _connecting = false;
  return _redis;
}

const KEY_PREFIX = "cache:";

function namespaced(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

/**
 * Set a key with a TTL in seconds. Overwrites any existing value.
 * Returns true on success, false on transport / serialisation failure.
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    const redis = await getRedis();
    await redis.set(namespaced(key), JSON.stringify(value), { EX: ttlSeconds });
    return true;
  } catch (err) {
    console.error(
      `[redis-cache] set failed for ${key}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Read and parse a cached JSON value. Returns null on miss, eviction,
 * or any transport / parse error — callers treat all three the same.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(namespaced(key));
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(
      `[redis-cache] get failed for ${key}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Non-blocking SCAN MATCH over the cache. Returns the matching keys
 * with the shared `cache:` prefix already stripped (so they line up
 * with the keys you'd pass to `cacheGet` / `cacheSet` / `cacheDel`).
 *
 * The `pattern` argument is the *user-facing* glob — we splice the
 * `cache:` prefix on internally so callers don't have to know about
 * the namespace. Empty result on transport failure.
 *
 * Bounded by `maxKeys` to keep a pathological scan from blocking the
 * caller forever on a pattern that accidentally matches a lot. The
 * default is generous (1024) but well below the millions of keys a
 * busy Redis can hold.
 */
export async function cacheScanKeys(
  pattern: string,
  maxKeys = 1024,
): Promise<string[]> {
  try {
    const redis = await getRedis();
    const matches: string[] = [];
    const fullPattern = namespaced(pattern);
    for await (const key of redis.scanIterator({
      MATCH: fullPattern,
      COUNT: 100,
    })) {
      // The redis npm package types `scanIterator` as yielding either
      // a single string or a string[] depending on version — normalise.
      const arr = Array.isArray(key) ? key : [key];
      for (const k of arr) {
        if (typeof k !== "string") continue;
        // Strip the namespace prefix on the way out so callers see the
        // same shape as the keys they pass in.
        matches.push(k.startsWith(KEY_PREFIX) ? k.slice(KEY_PREFIX.length) : k);
        if (matches.length >= maxKeys) return matches;
      }
    }
    return matches;
  } catch (err) {
    console.error(
      `[redis-cache] scan failed for ${pattern}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Delete a key. Idempotent — deleting a missing key is a no-op. */
export async function cacheDel(key: string): Promise<boolean> {
  try {
    const redis = await getRedis();
    await redis.del(namespaced(key));
    return true;
  } catch (err) {
    console.error(
      `[redis-cache] del failed for ${key}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// ─── Public event link key helper ────────────────────────────────────────

/**
 * Cache key for a public event share link. Token is included in the
 * key directly — anyone who has both the eventId and the token from
 * the URL can read the cached snapshot; that's the design.
 *
 * Both inputs are normalised (URI-decoded by the resolver before this
 * is called) and concatenated with a `:` separator. The full key the
 * resolver writes ends up looking like
 * `cache:public-event:<eventId>:<token>`.
 */
export function publicEventCacheKey(eventId: string, token: string): string {
  return `public-event:${eventId}:${token}`;
}
