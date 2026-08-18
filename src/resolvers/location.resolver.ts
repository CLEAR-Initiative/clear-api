import { randomUUID } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { requireRole } from "../utils/auth-guard.js";
import { computeAncestorIds, findOrCreateLandmarkL4 } from "../utils/geo-resolve.js";
import { DEFAULT_LOCALE } from "../utils/locales.js";
import { enqueueTranslationDurable } from "../services/translation-queue.js";

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

/**
 * Build a closed MULTIPOLYGON WKT ring from a `[minLng, minLat, maxLng, maxLat]`
 * bounding box. A polygon (NOT POINT(0 0)) is required so later spatial
 * event/crisis queries against the country geometry return results.
 *
 * Pure + exported so the geometry contract is unit-testable without a DB.
 * Throws on a malformed bbox so a bad call fails loudly rather than writing a
 * degenerate geometry.
 */
export function bboxToMultipolygonWkt(bbox: number[]): string {
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    bbox.some((n) => typeof n !== "number" || Number.isNaN(n))
  ) {
    throw new GraphQLError("bbox must be [minLng, minLat, maxLng, maxLat]", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  const [minLng, minLat, maxLng, maxLat] = bbox;
  if (minLng >= maxLng || minLat >= maxLat) {
    throw new GraphQLError(
      "bbox min must be strictly less than max on both axes",
      { extensions: { code: "BAD_USER_INPUT" } },
    );
  }
  // Closed ring, lng-lat order, counter-clockwise from the SW corner.
  return (
    `MULTIPOLYGON(((${minLng} ${minLat}, ${maxLng} ${minLat}, ` +
    `${maxLng} ${maxLat}, ${minLng} ${maxLat}, ${minLng} ${minLat})))`
  );
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

      // Compute ancestor IDs from the parent chain
      const ancestorIds = await computeAncestorIds(context.prisma, parentId);

      await context.prisma.$executeRaw`
        INSERT INTO "locations" ("id", "geonames_id", "osm_id", "p_code", "name", "level", "parent_id", "ancestor_ids", "geometry")
        VALUES (${id}, ${geoId}, ${osmId}, ${pCode}, ${input.name}, ${input.level}, ${parentId}, ${ancestorIds}, ST_GeomFromText('POINT(0 0)', 4326))
      `;

      return context.prisma.locations.findUniqueOrThrow({ where: { id } });
    },

    /**
     * Idempotent find-or-create of the level-0 Country location, by exact name.
     * Doubles as the pipeline's name→id resolution: returns the existing
     * Country if one exists, otherwise creates it with a bounding-box
     * MULTIPOLYGON geometry (NOT POINT(0 0)) so later spatial queries work.
     *
     * Accepts `admin` or `pipeline` (the least-privilege machine identity).
     */
    ensureCountryLocation: async (
      _parent: unknown,
      args: { name: string; bbox: number[] },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const name = args.name.trim();
      if (!name) {
        throw new GraphQLError("name is required", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Exact-name lookup of the level-0 Country. Found → return as-is
      // (idempotent: same name → same id, geometry untouched).
      const existing = await context.prisma.locations.findFirst({
        where: { name, level: 0 },
        orderBy: { id: "asc" },
      });
      if (existing) return existing;

      // Absent → create with bbox polygon geometry. `bboxToMultipolygonWkt`
      // validates the bbox and throws BAD_USER_INPUT on a bad shape.
      const wkt = bboxToMultipolygonWkt(args.bbox);
      const id = randomUUID();
      const noAncestors: string[] = [];
      await context.prisma.$executeRaw`
        INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
        VALUES (${id}, ${name}, 0, ${null}, ${noAncestors}, ST_GeomFromText(${wkt}, 4326))
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

    updateLocationGeometry: async (
      _parent: unknown,
      args: { id: string; geometry: unknown },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const geojson = JSON.stringify(args.geometry);

      // Invalidate the geometry cache for this location
      const cache = geoCache.get(context.prisma);
      if (cache) cache.delete(args.id);

      await context.prisma.$executeRaw`
        UPDATE "locations"
        SET "geometry" = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326))
        WHERE "id" = ${args.id}
      `;

      return context.prisma.locations.findUniqueOrThrow({ where: { id: args.id } });
    },

    updateLocationPopulation: async (
      _parent: unknown,
      args: { id: string; population: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      return context.prisma.locations.update({
        where: { id: args.id },
        data: { population: BigInt(args.population) },
      });
    },

    findOrCreateLandmarkL4: async (
      _parent: unknown,
      args: {
        input: {
          name: string;
          lat: number;
          lng: number;
          kind: string;
          sourceLat?: number | null;
          sourceLng?: number | null;
        };
      },
      context: Context,
    ) => {
      // Admin/pipeline only — this is internal infrastructure, not user-facing.
      requireRole(context, ["admin"]);
      const { input } = args;

      if (input.kind !== "landmark" && input.kind !== "admin") {
        throw new GraphQLError(
          `Invalid kind "${input.kind}" — expected 'landmark' or 'admin'`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      return findOrCreateLandmarkL4(context.prisma, {
        name: input.name,
        lat: input.lat,
        lng: input.lng,
        kind: input.kind,
        sourceLat: input.sourceLat ?? null,
        sourceLng: input.sourceLng ?? null,
      });
    },
  },
  Location: {
    // Localized name overlay. Prefers `parent.translations` when the
    // caller fetched the location via prisma with
    // `include: { translations: { where: { locale } } }` — that's the
    // path Event.{general,origin,destination}Location now uses. Falls
    // back to the per-request translationLoader for code paths that
    // didn't include translations (most other location call sites).
    // At locale === "en" both paths short-circuit to the canonical
    // column.
    name: async (
      parent: {
        id: string;
        name: string;
        translations?: Array<{ data: unknown }>;
      },
      _args: unknown,
      context: Context,
    ) => {
      if (context.locale === DEFAULT_LOCALE) return parent.name;
      if (parent.translations !== undefined) {
        const data = parent.translations[0]?.data as
          | { name?: unknown }
          | undefined;
        const localized = data?.name;
        if (typeof localized === "string") return localized;
        if (parent.translations.length === 0) {
          enqueueTranslationDurable(context.prisma, "location", parent.id, context.locale);
        }
        return parent.name;
      }
      const tr = await context.translationLoader.load("location", parent.id);
      const localized = tr?.name;
      return typeof localized === "string" ? localized : parent.name;
    },
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
    ancestorIds: (parent: { ancestorIds: string[] }) => {
      return parent.ancestorIds ?? [];
    },
    ancestors: (parent: { ancestorIds: string[] }, _args: unknown, { prisma }: Context) => {
      if (!parent.ancestorIds?.length) return [];
      return prisma.locations.findMany({
        where: { id: { in: parent.ancestorIds } },
        orderBy: { level: "asc" },
      });
    },
    population: (parent: { population: bigint | null }) => {
      return parent.population?.toString() ?? null;
    },
    metadata: (
      parent: { id: string },
      args: { type?: string; current?: boolean },
      { prisma }: Context,
    ) => {
      const onlyCurrent = args.current ?? true;
      return prisma.locationMetadata.findMany({
        where: {
          locationId: parent.id,
          ...(args.type ? { type: args.type } : {}),
          ...(onlyCurrent ? { validTo: null } : {}),
        },
        orderBy: { validFrom: "desc" },
      });
    },
  },
};
