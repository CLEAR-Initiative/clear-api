import { randomUUID } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateLocationInput {
  geoId?: number;
  osmId?: string; // BigInt as string from GraphQL
  pCode?: string;
  name: string;
  level: number;
  parentId?: string;
}

interface UpdateLocationInput {
  geoId?: number;
  osmId?: string;
  pCode?: string;
  name?: string;
  level?: number;
  parentId?: string;
}

/* ── Helper: fetch geometry GeoJSON for a location via raw SQL ── */
interface LocationGeoRow {
  geometry_geojson: string | null;
}

const geoCache = new WeakMap<PrismaClient, Map<string, Promise<LocationGeoRow | null>>>();

function fetchLocationGeo(
  prisma: PrismaClient,
  id: string,
): Promise<LocationGeoRow | null> {
  let cache = geoCache.get(prisma);
  if (!cache) {
    cache = new Map();
    geoCache.set(prisma, cache);
  }

  const existing = cache.get(id);
  if (existing) return existing;

  const promise = prisma
    .$queryRaw<LocationGeoRow[]>`
      SELECT
        ST_AsGeoJSON("geometry") as geometry_geojson
      FROM "locations"
      WHERE "id" = ${id}
    `
    .then((rows) => rows[0] ?? null);

  cache.set(id, promise);
  return promise;
}

export const locationResolvers = {
  Query: {
    locations: (_parent: unknown, args: { level?: number }, { prisma }: Context) => {
      return prisma.locations.findMany({
        where: args.level !== undefined ? { level: args.level } : undefined,
      });
    },
    location: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.locations.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createLocation: async (
      _parent: unknown,
      args: { input: CreateLocationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { input } = args;
      const id = randomUUID();
      const geoId = input.geoId ?? null;
      const osmId = input.osmId ? BigInt(input.osmId) : null;
      const pCode = input.pCode ?? null;
      const parentId = input.parentId ?? null;

      await context.prisma.$executeRaw`
        INSERT INTO "locations" ("id", "geonames_id", "osm_id", "p_code", "name", "level", "parent_id", "geometry")
        VALUES (${id}, ${geoId}, ${osmId}, ${pCode}, ${input.name}, ${input.level}, ${parentId}, ST_GeomFromText('POINT(0 0)', 4326))
      `;

      return context.prisma.locations.findUniqueOrThrow({ where: { id } });
    },

    updateLocation: async (
      _parent: unknown,
      args: { id: string; input: UpdateLocationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { id, input } = args;

      const existing = await context.prisma.locations.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Location not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Build SET clauses dynamically using Prisma.sql for safe parameterization
      const setClauses: Prisma.Sql[] = [];

      if (input.geoId !== undefined) {
        setClauses.push(Prisma.sql`"geonames_id" = ${input.geoId}`);
      }
      if (input.osmId !== undefined) {
        setClauses.push(Prisma.sql`"osm_id" = ${BigInt(input.osmId)}`);
      }
      if (input.pCode !== undefined) {
        setClauses.push(Prisma.sql`"p_code" = ${input.pCode}`);
      }
      if (input.name !== undefined) {
        setClauses.push(Prisma.sql`"name" = ${input.name}`);
      }
      if (input.level !== undefined) {
        setClauses.push(Prisma.sql`"level" = ${input.level}`);
      }
      if (input.parentId !== undefined) {
        setClauses.push(Prisma.sql`"parent_id" = ${input.parentId}`);
      }

      if (setClauses.length > 0) {
        await context.prisma.$executeRaw`
          UPDATE "locations"
          SET ${Prisma.join(setClauses, ", ")}
          WHERE "id" = ${id}
        `;
      }

      return context.prisma.locations.findUniqueOrThrow({ where: { id } });
    },

    deleteLocation: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.locations.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Location not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.$executeRaw`
        DELETE FROM "locations" WHERE "id" = ${args.id}
      `;
      return true;
    },
  },
  Location: {
    parent: (parent: { parentId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.parentId) return null;
      return prisma.locations.findUnique({ where: { id: parent.parentId } });
    },
    children: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.locations.findMany({ where: { parentId: parent.id } });
    },
    geometry: async (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      const geo = await fetchLocationGeo(prisma, parent.id);
      if (!geo?.geometry_geojson) return null;
      return JSON.parse(geo.geometry_geojson) as unknown;
    },
  },
};
