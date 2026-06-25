/**
 * Public event share links — Redis-only storage by design (no new DB
 * table). A mint mutation writes a slim snapshot of the event into
 * Redis under a (eventId, token) key with a TTL; the public query
 * reads it back without auth.
 *
 * When the cache key is evicted (eviction-policy memory pressure or
 * server restart) the link simply expires and the user has to mint a
 * new one — a cost we accept in exchange for not adding a table.
 */

import { randomBytes } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireContentReader } from "../utils/auth-guard.js";
import { env } from "../utils/env.js";
import {
  cacheDel,
  cacheGet,
  cacheScanKeys,
  cacheSet,
  publicEventCacheKey,
} from "../services/redis-cache.js";

interface CreatePublicEventLinkInput {
  eventId: string;
  ttlDays?: number | null;
}

/** Maximum and default TTL for share links, in days. */
const MAX_TTL_DAYS = 90;
const DEFAULT_TTL_DAYS = 30;

/** Random byte count for the share token. 32 bytes → 43 char base64url. */
const TOKEN_BYTES = 32;

/**
 * Slim, snapshot-time view of an event that's safe to expose without
 * auth. Anything not in this shape never reaches the public surface.
 *
 * Keep in sync with the `PublicEvent` GraphQL type — the resolver
 * returns this object verbatim, GraphQL field selection just picks
 * fields off it.
 */
interface PublicEventSnapshot {
  id: string;
  title: string | null;
  description: string | null;
  severity: number | null;
  validFrom: string;
  validTo: string;
  types: string[];
  primaryLocationName: string | null;
  primaryLocationCoords: [number, number] | null;
  populationAffected: string | null;
  populationDisplaced: string | null;
  sharedAt: string;
  expiresAt: string;
}

/**
 * Pull `[lng, lat]` for the given location id when its PostGIS
 * geometry is a Point. Returns null for polygon-only locations or a
 * missing row — the public page hides the minimap in either case.
 *
 * Uses a raw query because Prisma can't represent the PostGIS
 * `geometry` column (it's declared `Unsupported(…)` in the schema).
 */
async function pointCoordsForLocation(
  prisma: Context["prisma"],
  locationId: string,
): Promise<[number, number] | null> {
  const rows = await prisma.$queryRaw<Array<{ lng: number; lat: number }>>`
    SELECT ST_X("geometry"::geometry) AS lng, ST_Y("geometry"::geometry) AS lat
    FROM "locations"
    WHERE id = ${locationId}
      AND "geometry" IS NOT NULL
      AND ST_GeometryType("geometry"::geometry) = 'ST_Point'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (typeof row.lng !== "number" || typeof row.lat !== "number") return null;
  return [row.lng, row.lat];
}

export const publicEventResolvers = {
  Query: {
    publicEvent: async (
      _parent: unknown,
      args: { eventId: string; token: string },
      _context: Context,
    ) => {
      // No auth gate — the (eventId, token) pair from the URL is the
      // entire access check, and the cache miss path returns null
      // which surfaces as "Link expired" on the frontend.
      const key = publicEventCacheKey(args.eventId, args.token);
      const snapshot = await cacheGet<PublicEventSnapshot>(key);
      if (!snapshot) return null;
      // Defensive: a cache poisoning attempt couldn't change the
      // eventId since the key embeds it, but reassert anyway so a
      // future helper change can't silently break the contract.
      if (snapshot.id !== args.eventId) return null;
      return snapshot;
    },

    existingPublicEventLink: async (
      _parent: unknown,
      args: { eventId: string },
      context: Context,
    ) => {
      // Same gate as mint — pending users blocked, viewer / analyst /
      // admin allowed. Idempotent reads on the cache don't expose
      // anything the caller couldn't already see by minting, but the
      // role check keeps the surface tidy.
      requireContentReader(context);

      // SCAN the prefix to find every live share key for this event.
      // For a single event the cardinality is tiny (a handful at
      // most), so reading every snapshot to compare sharedAt is fine.
      const keyPrefix = publicEventCacheKey(args.eventId, "");
      const keys = await cacheScanKeys(`${keyPrefix}*`);
      if (keys.length === 0) return null;

      let latest: { snapshot: PublicEventSnapshot; token: string } | null = null;
      for (const key of keys) {
        const snap = await cacheGet<PublicEventSnapshot>(key);
        if (!snap || snap.id !== args.eventId) continue;
        // Token is whatever follows the final ":" in the key. Tokens
        // are random base64url; they never contain colons themselves.
        const token = key.slice(keyPrefix.length);
        if (!token) continue;
        if (!latest || snap.sharedAt > latest.snapshot.sharedAt) {
          latest = { snapshot: snap, token };
        }
      }
      if (!latest) return null;

      const url = `${env.FRONTEND_URL.replace(/\/$/, "")}/public/event/${args.eventId}/${latest.token}`;
      return {
        token: latest.token,
        url,
        expiresAt: latest.snapshot.expiresAt,
      };
    },
  },

  Mutation: {
    createPublicEventLink: async (
      _parent: unknown,
      args: { input: CreatePublicEventLinkInput },
      context: Context,
    ) => {
      // Mint requires read access to the event — same gate as the
      // authenticated `event(id)` query. Pending users blocked.
      requireContentReader(context);

      const { eventId } = args.input;
      const ttlDays = Math.min(
        MAX_TTL_DAYS,
        Math.max(1, args.input.ttlDays ?? DEFAULT_TTL_DAYS),
      );

      // Fetch the live event, including the three location relations
      // (just `id` + `name` — geometry is a PostGIS column Prisma
      // can't select, so we hit it separately below if we need it for
      // the minimap).
      const event = await context.prisma.events.findUnique({
        where: { id: eventId },
        include: {
          generalLocation: { select: { id: true, name: true } },
          originLocation: { select: { id: true, name: true } },
          destinationLocation: { select: { id: true, name: true } },
        },
      });
      if (!event) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Resolve the primary location (general → origin → destination,
      // first non-null). Mirrors the eventLocations helper on the
      // frontend so the share card looks the same as the in-app view.
      const primary =
        event.generalLocation ??
        event.originLocation ??
        event.destinationLocation ??
        null;

      const primaryCoords = primary
        ? await pointCoordsForLocation(context.prisma, primary.id)
        : null;

      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

      const snapshot: PublicEventSnapshot = {
        id: event.id,
        title: event.title ?? null,
        description: event.description ?? null,
        severity: event.severity ?? null,
        validFrom: event.validFrom.toISOString(),
        validTo: event.validTo.toISOString(),
        types: event.types,
        primaryLocationName: primary?.name ?? null,
        primaryLocationCoords: primaryCoords,
        populationAffected:
          event.populationAffected != null ? event.populationAffected.toString() : null,
        populationDisplaced:
          event.populationDisplaced != null ? event.populationDisplaced.toString() : null,
        sharedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };

      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      const key = publicEventCacheKey(eventId, token);
      const ttlSeconds = ttlDays * 24 * 60 * 60;
      const ok = await cacheSet(key, snapshot, ttlSeconds);
      if (!ok) {
        // Redis is the source of truth for this feature; if the write
        // fails the link wouldn't resolve on the public side anyway.
        // Surface that as a typed error so the admin UI shows it.
        throw new GraphQLError(
          "Could not write share link to cache. Try again, or contact support if it persists.",
          { extensions: { code: "INTERNAL_SERVER_ERROR" } },
        );
      }

      const url = `${env.FRONTEND_URL.replace(/\/$/, "")}/public/event/${eventId}/${token}`;

      return { token, url, expiresAt };
    },

    revokePublicEventLink: async (
      _parent: unknown,
      args: { eventId: string; token: string },
      context: Context,
    ) => {
      // Same gate as mint. Pending users blocked; viewer / analyst /
      // admin can all revoke. Ownership-of-link isn't checked because
      // the link is unauthenticated by design and the only revocable
      // state is the cache entry itself.
      requireContentReader(context);
      await cacheDel(publicEventCacheKey(args.eventId, args.token));
      return true;
    },
  },
};
