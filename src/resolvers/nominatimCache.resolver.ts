/**
 * Resolvers for the Nominatim geocoder cache. Admin-only — these endpoints
 * exist for the clear-pipeline geoparser, not for user-facing consumers.
 *
 * Lookup is by `queryHash`; expired rows (expires_at < NOW()) are filtered
 * out at read time so callers never see stale entries. Writes upsert by
 * `queryHash`, replacing any existing row for the same hash.
 */

import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";

interface UpsertNominatimCacheInput {
  queryHash: string;
  query: string;
  endpoint: string;
  responseJson: unknown;
  status: string;
  ttlSeconds: number;
}

const ALLOWED_STATUSES = new Set(["ok", "no_result", "error"]);

export const nominatimCacheResolvers = {
  Query: {
    nominatimCacheEntry: async (
      _parent: unknown,
      args: { queryHash: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      // Filter out expired rows at read time. The pipeline doesn't need to
      // distinguish "missing" from "expired" — both mean cache miss.
      const entry = await context.prisma.nominatim_cache.findFirst({
        where: {
          queryHash: args.queryHash,
          expiresAt: { gt: new Date() },
        },
      });
      return entry;
    },
  },

  Mutation: {
    upsertNominatimCache: async (
      _parent: unknown,
      args: { input: UpsertNominatimCacheInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { input } = args;

      if (!ALLOWED_STATUSES.has(input.status)) {
        throw new GraphQLError(
          `Invalid status '${input.status}'. Must be one of: ${[...ALLOWED_STATUSES].join(", ")}.`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      if (input.ttlSeconds <= 0) {
        throw new GraphQLError(`ttlSeconds must be positive, got ${input.ttlSeconds}.`, {
          extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);

      // Upsert on queryHash. If a row already exists for this hash, replace
      // its content + reset the TTL. This is what lets a cached 'error' get
      // refreshed to 'ok' once the geocoder recovers.
      const data = {
        query: input.query,
        endpoint: input.endpoint,
        responseJson: input.responseJson as InputJsonValue,
        status: input.status,
        fetchedAt: now,
        expiresAt,
      };

      return context.prisma.nominatim_cache.upsert({
        where: { queryHash: input.queryHash },
        update: data,
        create: { queryHash: input.queryHash, ...data },
      });
    },
  },
};
