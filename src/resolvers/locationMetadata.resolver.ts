import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";

interface UpsertLocationMetadataInput {
  locationId: string;
  type: string;
  data: Record<string, unknown>;
}

export const locationMetadataResolvers = {
  Query: {
    locationMetadata: async (
      _parent: unknown,
      args: { locationId: string; type?: string },
      context: Context,
    ) => {
      requireAuth(context);
      return context.prisma.locationMetadata.findMany({
        where: {
          locationId: args.locationId,
          ...(args.type ? { type: args.type } : {}),
        },
        orderBy: { updatedAt: "desc" },
      });
    },

    allLocationMetadata: async (
      _parent: unknown,
      args: { type: string },
      context: Context,
    ) => {
      requireAuth(context);
      return context.prisma.locationMetadata.findMany({
        where: { type: args.type },
        orderBy: { updatedAt: "desc" },
      });
    },
  },

  Mutation: {
    upsertLocationMetadata: async (
      _parent: unknown,
      args: { input: UpsertLocationMetadataInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
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

      return context.prisma.locationMetadata.upsert({
        where: {
          locationId_type: { locationId: input.locationId, type: input.type },
        },
        create: {
          locationId: input.locationId,
          type: input.type,
          data: input.data as InputJsonValue,
        },
        update: {
          data: input.data as InputJsonValue,
        },
      });
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

      // Prisma has no true multi-row upsert — run inside a transaction so
      // either all rows land or none do.
      const results = await context.prisma.$transaction(
        valid.map((i) =>
          context.prisma.locationMetadata.upsert({
            where: {
              locationId_type: { locationId: i.locationId, type: i.type },
            },
            create: {
              locationId: i.locationId,
              type: i.type,
              data: i.data as InputJsonValue,
            },
            update: {
              data: i.data as InputJsonValue,
            },
          }),
        ),
      );
      return results;
    },

    deleteLocationMetadata: async (
      _parent: unknown,
      args: { locationId: string; type: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const result = await context.prisma.locationMetadata.deleteMany({
        where: { locationId: args.locationId, type: args.type },
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
