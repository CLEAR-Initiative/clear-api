import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";

interface UpsertLocationMetadataInput {
  locationId: string;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Build the `where` clause for "only current rows" (validTo IS NULL).
 * Kept here so the semantics match everywhere.
 */
const CURRENT_FILTER = { validTo: null };

export const locationMetadataResolvers = {
  Query: {
    locationMetadata: async (
      _parent: unknown,
      args: { locationId: string; type?: string; current?: boolean },
      context: Context,
    ) => {
      requireAuth(context);
      const onlyCurrent = args.current ?? true;
      return context.prisma.locationMetadata.findMany({
        where: {
          locationId: args.locationId,
          ...(args.type ? { type: args.type } : {}),
          ...(onlyCurrent ? CURRENT_FILTER : {}),
        },
        orderBy: { validFrom: "desc" },
      });
    },

    allLocationMetadata: async (
      _parent: unknown,
      args: { type: string; current?: boolean },
      context: Context,
    ) => {
      requireAuth(context);
      const onlyCurrent = args.current ?? true;
      return context.prisma.locationMetadata.findMany({
        where: {
          type: args.type,
          ...(onlyCurrent ? CURRENT_FILTER : {}),
        },
        orderBy: { validFrom: "desc" },
      });
    },

    locationMetadataHistory: async (
      _parent: unknown,
      args: { locationId: string; type: string },
      context: Context,
    ) => {
      requireAuth(context);
      return context.prisma.locationMetadata.findMany({
        where: { locationId: args.locationId, type: args.type },
        orderBy: { validFrom: "desc" },
      });
    },
  },

  Mutation: {
    upsertLocationMetadata: async (
      _parent: unknown,
      args: { input: UpsertLocationMetadataInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const { input } = args;

      const location = await context.prisma.locations.findUnique({
        where: { id: input.locationId },
        select: { id: true },
      });
      if (!location) {
        throw new GraphQLError("Location not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const now = new Date();

      // Close + insert atomically so no window exists where the row is
      // either missing or duplicated.
      const [, created] = await context.prisma.$transaction([
        context.prisma.locationMetadata.updateMany({
          where: {
            locationId: input.locationId,
            type: input.type,
            validTo: null,
          },
          data: { validTo: now },
        }),
        context.prisma.locationMetadata.create({
          data: {
            locationId: input.locationId,
            type: input.type,
            data: input.data as InputJsonValue,
            validFrom: now,
          },
        }),
      ]);
      return created;
    },

    upsertLocationMetadataBatch: async (
      _parent: unknown,
      args: { inputs: UpsertLocationMetadataInput[] },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { inputs } = args;

      if (inputs.length === 0) return [];

      // Pre-filter to locationIds that actually exist (one query)
      const requestedIds = [...new Set(inputs.map((i) => i.locationId))];
      const existing = await context.prisma.locations.findMany({
        where: { id: { in: requestedIds } },
        select: { id: true },
      });
      const validIds = new Set(existing.map((l) => l.id));

      const valid = inputs.filter((i) => validIds.has(i.locationId));
      if (valid.length < inputs.length) {
        console.warn(
          `[upsertLocationMetadataBatch] skipping ${inputs.length - valid.length} rows with unknown locationId`,
        );
      }

      if (valid.length === 0) return [];

      const now = new Date();

      // Two steps inside one transaction (callback form so we can pass a
      // generous timeout — array form is capped at the default 5s, which a
      // 200-row IOM DTM batch routinely exceeds against a remote DB):
      //   1. Close every currently-open row matching any (locationId, type)
      //      in the batch (one updateMany with an OR clause).
      //   2. Insert all new rows in a createMany (one round-trip instead of N).
      const closeClauses = valid.map((i) => ({
        locationId: i.locationId,
        type: i.type,
        validTo: null,
      }));

      const newRowsData = valid.map((i) => ({
        locationId: i.locationId,
        type: i.type,
        data: i.data as InputJsonValue,
        validFrom: now,
      }));

      const created = await context.prisma.$transaction(
        async (tx) => {
          await tx.locationMetadata.updateMany({
            where: { OR: closeClauses },
            data: { validTo: now },
          });
          await tx.locationMetadata.createMany({ data: newRowsData });
          // Return the rows just created. Identifiable by validFrom = now
          // (set above) — safer than relying on insertion order.
          return tx.locationMetadata.findMany({
            where: {
              type: { in: [...new Set(valid.map((i) => i.type))] },
              locationId: { in: valid.map((i) => i.locationId) },
              validFrom: now,
            },
          });
        },
        { timeout: 60_000, maxWait: 10_000 },
      );

      return created;
    },

    /**
     * Soft-delete: closes the current row (sets validTo = now) without
     * wiping history. Returns true iff a currently-open row was found.
     */
    deleteLocationMetadata: async (
      _parent: unknown,
      args: { locationId: string; type: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const result = await context.prisma.locationMetadata.updateMany({
        where: {
          locationId: args.locationId,
          type: args.type,
          validTo: null,
        },
        data: { validTo: new Date() },
      });
      return result.count > 0;
    },
  },

  LocationMetadata: {
    location: (
      parent: { locationId: string },
      _args: unknown,
      { prisma }: Context,
    ) => {
      return prisma.locations.findUnique({ where: { id: parent.locationId } });
    },
  },
};
