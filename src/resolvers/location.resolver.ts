import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateLocationInput {
  geoId: string;
  name: string;
  level: number;
  pointType?: string;
  parentId?: string;
  latitude?: number;
  longitude?: number;
}

interface UpdateLocationInput {
  geoId?: string;
  name?: string;
  level?: number;
  pointType?: string;
  parentId?: string;
  latitude?: number;
  longitude?: number;
}

/* ── Helper: fetch all geo data for a location in one raw query ── */
interface LocationGeoRow {
  lat: number | null;
  lng: number | null;
  point_geojson: string | null;
  boundary_geojson: string | null;
  point_type: string | null;
}

// Per-request cache to avoid N+1 queries when multiple geo fields are resolved
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
        ST_Y("point"::geometry) as lat,
        ST_X("point"::geometry) as lng,
        ST_AsGeoJSON("point"::geometry) as point_geojson,
        ST_AsGeoJSON("boundary") as boundary_geojson,
        "pointType" as point_type
      FROM "Location"
      WHERE "id" = ${id}
    `
    .then((rows) => rows[0] ?? null);

  cache.set(id, promise);
  return promise;
}

/* ── Helper: set point geometry via raw SQL ── */
async function setPointGeometry(
  prisma: PrismaClient,
  locationId: string,
  longitude: number,
  latitude: number,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Location"
    SET "point" = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
    WHERE "id" = ${locationId}
  `;
}

export const locationResolvers = {
  Query: {
    locations: (_parent: unknown, args: { level?: number }, { prisma }: Context) => {
      return prisma.location.findMany({
        where: args.level !== undefined ? { level: args.level } : undefined,
      });
    },
    location: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.location.findUnique({ where: { id: args.id } });
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

      const location = await context.prisma.location.create({
        data: {
          geoId: input.geoId,
          name: input.name,
          level: input.level,
          pointType: input.pointType as "CENTROID" | "GPS" | undefined,
          parentId: input.parentId,
        },
      });

      if (input.latitude != null && input.longitude != null) {
        await setPointGeometry(context.prisma, location.id, input.longitude, input.latitude);
      }

      return location;
    },

    updateLocation: async (
      _parent: unknown,
      args: { id: string; input: UpdateLocationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { id, input } = args;

      const existing = await context.prisma.location.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Location not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const location = await context.prisma.location.update({
        where: { id },
        data: {
          geoId: input.geoId ?? undefined,
          name: input.name ?? undefined,
          level: input.level ?? undefined,
          pointType: input.pointType as "CENTROID" | "GPS" | undefined,
          parentId: input.parentId,
        },
      });

      if (input.latitude != null && input.longitude != null) {
        await setPointGeometry(context.prisma, location.id, input.longitude, input.latitude);
      }

      return location;
    },

    deleteLocation: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.location.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Location not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.location.delete({ where: { id: args.id } });
      return true;
    },
  },
  Location: {
    parent: (parent: { parentId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.parentId) return null;
      return prisma.location.findUnique({ where: { id: parent.parentId } });
    },
    children: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.location.findMany({ where: { parentId: parent.id } });
    },
    alertLinks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alertLocation.findMany({ where: { locationId: parent.id } });
    },
    detectionLinks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.detectionLocation.findMany({ where: { locationId: parent.id } });
    },
    latitude: async (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      const geo = await fetchLocationGeo(prisma, parent.id);
      return geo?.lat ?? null;
    },
    longitude: async (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      const geo = await fetchLocationGeo(prisma, parent.id);
      return geo?.lng ?? null;
    },
    pointType: async (parent: { id: string; pointType?: string | null }, _args: unknown, { prisma }: Context) => {
      // pointType is a regular Prisma field, so it may already be on the parent
      if (parent.pointType !== undefined) return parent.pointType;
      const geo = await fetchLocationGeo(prisma, parent.id);
      return geo?.point_type ?? null;
    },
    point: async (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      const geo = await fetchLocationGeo(prisma, parent.id);
      if (!geo?.point_geojson) return null;
      return JSON.parse(geo.point_geojson) as unknown;
    },
    boundary: async (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      const geo = await fetchLocationGeo(prisma, parent.id);
      if (!geo?.boundary_geojson) return null;
      return JSON.parse(geo.boundary_geojson) as unknown;
    },
  },
  AlertLocation: {
    alert: (parent: { alertId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alert.findUnique({ where: { id: parent.alertId } });
    },
    location: (parent: { locationId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.location.findUnique({ where: { id: parent.locationId } });
    },
  },
  DetectionLocation: {
    detection: (parent: { detectionId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.detection.findUnique({ where: { id: parent.detectionId } });
    },
    location: (parent: { locationId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.location.findUnique({ where: { id: parent.locationId } });
    },
  },
};
