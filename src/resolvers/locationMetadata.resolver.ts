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

/**
 * Canonical JSON string: object keys sorted recursively (key order is
 * insignificant in JSON), array order preserved (significant). Used by the
 * batch upsert to detect when an incoming blob is byte-identical to the
 * currently-open row so a no-op re-ingest doesn't append a redundant history
 * row. Note: array order IS compared, so producers must emit stable ordering to
 * benefit (unstable order just falls through to a normal supersede — never a
 * correctness issue).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

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
      // Pipeline ingests (clear-pipeline location-metadata assets) call
      // this with the `pipeline` role — matching the single-row upsert.
      requireRole(context, ["admin", "pipeline"]);
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
      const keyOf = (locationId: string, type: string) => JSON.stringify([locationId, type]);

      // One transaction (callback form so we can pass a generous timeout — array
      // form is capped at the default 5s, which a 200-row IOM DTM batch routinely
      // exceeds against a remote DB):
      //   1. Read the currently-open row for each (locationId, type) in the batch.
      //   2. Skip inputs whose blob is byte-identical to that open row — a no-op
      //      re-ingest must not append a redundant history version (idempotent
      //      re-materialisation). Those rows are returned unchanged.
      //   3. For the rest, close the open row (validTo = now) and insert the new
      //      one (createMany, one round-trip).
      const created = await context.prisma.$transaction(
        async (tx) => {
          const openRows = await tx.locationMetadata.findMany({
            where: {
              OR: valid.map((i) => ({
                locationId: i.locationId,
                type: i.type,
                validTo: null,
              })),
            },
          });
          const openByKey = new Map(
            openRows.map((r) => [keyOf(r.locationId, r.type), r]),
          );

          const changed: UpsertLocationMetadataInput[] = [];
          const unchanged: typeof openRows = [];
          for (const i of valid) {
            const open = openByKey.get(keyOf(i.locationId, i.type));
            if (open && stableStringify(open.data) === stableStringify(i.data)) {
              unchanged.push(open);
            } else {
              changed.push(i);
            }
          }

          // Everything already current — no writes at all, return the open rows.
          if (changed.length === 0) return unchanged;

          await tx.locationMetadata.updateMany({
            where: {
              OR: changed.map((i) => ({
                locationId: i.locationId,
                type: i.type,
                validTo: null,
              })),
            },
            data: { validTo: now },
          });
          await tx.locationMetadata.createMany({
            data: changed.map((i) => ({
              locationId: i.locationId,
              type: i.type,
              data: i.data as InputJsonValue,
              validFrom: now,
            })),
          });
          // The rows just created are identifiable by validFrom = now (set
          // above) — safer than relying on insertion order. Return them
          // alongside the unchanged open rows so the caller sees the current
          // row for every input it sent.
          const inserted = await tx.locationMetadata.findMany({
            where: {
              type: { in: [...new Set(changed.map((i) => i.type))] },
              locationId: { in: changed.map((i) => i.locationId) },
              validFrom: now,
            },
          });
          return [...inserted, ...unchanged];
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
