import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { resolveTeamMembership } from "../utils/auth-guard.js";
import { createPointLocation, getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { buildLocationFilterForTeam } from "../utils/location-scope.js";
import { uploadFileToS3 } from "../services/s3.js";
import { sendCeleryTask } from "../services/celery.js";

const TRUSTED_SOURCE_NAMES = new Set(["field_officer", "partner", "government"]);

interface FileUpload {
  filename: string;
  mimetype: string;
  encoding: string;
  createReadStream: () => NodeJS.ReadableStream;
}

interface CreateManualSignalInput {
  sourceId: string;
  title: string;
  description: string;
  severity?: number;
  url?: string;
  /** Media URLs (pre-uploaded via /api/upload endpoint) */
  mediaUrls?: string[];
  /** Media files (direct upload via graphql-upload) */
  media?: Promise<FileUpload>[];
  locationId?: string;
  originId?: string;
  destinationId?: string;
  lat?: number;
  lng?: number;
}

interface CreateSignalInput {
  sourceId: string;
  rawData: Record<string, unknown>;
  publishedAt: string;
  collectedAt?: string;
  url?: string;
  title?: string;
  description?: string;
  severity?: number;
  /** Media URLs from source (stored directly, no S3 upload) */
  media?: string[];
  originId?: string;
  destinationId?: string;
  locationId?: string;
  lat?: number;
  lng?: number;
}

export const signalResolvers = {
  Query: {
    signals: async (_parent: unknown, args: { teamId?: string; includeDummy?: boolean }, context: Context) => {
      const user = requireAuth(context);
      const dummyFilter = args.includeDummy ? {} : { isDummy: false };
      if (!args.teamId) {
        if (user.role !== "admin") {
          throw new GraphQLError("teamId is required", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        return context.prisma.signals.findMany({ where: dummyFilter });
      }
      await resolveTeamMembership(context.prisma, user.id, args.teamId, user.role);
      const filter = await buildLocationFilterForTeam(context.prisma, args.teamId);
      return context.prisma.signals.findMany({ where: { ...filter, ...dummyFilter } });
    },
    signalsByLocation: async (_parent: unknown, args: { locationId: string }, context: Context) => {
      requireAuth(context);
      const locationIds = await getLocationIdsWithDescendants(context.prisma, args.locationId);
      return context.prisma.signals.findMany({
        where: {
          OR: [
            { originId: { in: locationIds } },
            { destinationId: { in: locationIds } },
            { locationId: { in: locationIds } },
          ],
        },
      });
    },
    signal: async (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireAuth(context);
      const signal = await context.prisma.signals.findUnique({ where: { id: args.id } });
      if (!signal) return null;
      if (user.role !== "admin") {
        const teamMemberships = await context.prisma.teamMembers.findMany({
          where: { userId: user.id },
          select: { teamId: true },
        });
        if (teamMemberships.length === 0) {
          throw new GraphQLError("No team membership found", {
            extensions: { code: "FORBIDDEN" },
          });
        }
        let accessible = false;
        for (const { teamId } of teamMemberships) {
          const filter = await buildLocationFilterForTeam(context.prisma, teamId);
          if (!filter) { accessible = true; break; }
          const found = await context.prisma.signals.findFirst({
            where: { id: args.id, ...filter },
          });
          if (found) { accessible = true; break; }
        }
        if (!accessible) {
          throw new GraphQLError("Signal not accessible from your teams", {
            extensions: { code: "FORBIDDEN" },
          });
        }
      }
      return signal;
    },
  },
  Mutation: {
    createSignal: async (
      _parent: unknown,
      args: { input: CreateSignalInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      const dataSource = await context.prisma.dataSources.findUnique({
        where: { id: input.sourceId },
      });
      if (!dataSource) {
        throw new GraphQLError("DataSource not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Resolve lat/lng to a level-4 point location if no explicit locationId is provided
      let locationId = input.locationId;
      if (!locationId && input.lat != null && input.lng != null) {
        const pointLoc = await createPointLocation(
          context.prisma,
          input.lat,
          input.lng,
          input.title ?? undefined,
        );
        locationId = pointLoc.id;
      }

      return context.prisma.signals.create({
        data: {
          sourceId: input.sourceId,
          rawData: input.rawData as InputJsonValue,
          publishedAt: new Date(input.publishedAt),
          collectedAt: input.collectedAt ? new Date(input.collectedAt) : new Date(),
          url: input.url,
          title: input.title,
          description: input.description,
          severity: input.severity,
          media: input.media ?? [],
          originId: input.originId,
          destinationId: input.destinationId,
          locationId,
        },
      });
    },

    createManualSignal: async (
      _parent: unknown,
      args: { input: CreateManualSignalInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      // Validate source exists and is a trusted type
      const dataSource = await context.prisma.dataSources.findUnique({
        where: { id: input.sourceId },
      });
      if (!dataSource) {
        throw new GraphQLError("DataSource not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (!TRUSTED_SOURCE_NAMES.has(dataSource.name)) {
        throw new GraphQLError(
          `Manual signals must use a trusted source (${[...TRUSTED_SOURCE_NAMES].join(", ")}), got "${dataSource.name}"`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      // Resolve location from lat/lng if needed
      let locationId = input.locationId;
      if (!locationId && input.lat != null && input.lng != null) {
        const pointLoc = await createPointLocation(
          context.prisma, input.lat, input.lng, input.title,
        );
        locationId = pointLoc.id;
      }

      // Collect media URLs — from pre-uploaded URLs and/or direct file uploads
      const media: string[] = [...(input.mediaUrls ?? [])];
      if (input.media && input.media.length > 0) {
        const files = await Promise.all(input.media);
        for (const file of files) {
          const url = await uploadFileToS3(file.createReadStream(), file.filename, file.mimetype);
          media.push(url);
        }
      }

      // Create the signal
      const signal = await context.prisma.signals.create({
        data: {
          sourceId: input.sourceId,
          rawData: {
            manual: true,
            createdBy: user.id,
            title: input.title,
            description: input.description,
          } as InputJsonValue,
          publishedAt: new Date(),
          collectedAt: new Date(),
          url: input.url,
          title: input.title,
          description: input.description,
          severity: input.severity,
          media,
          originId: input.originId,
          destinationId: input.destinationId,
          locationId,
        },
      });

      // Queue pipeline processing via Celery (fire-and-forget)
      void sendCeleryTask("src.tasks.process.process_manual_signal", {
        signal_id: signal.id,
        source_type: dataSource.name,
        title: input.title,
        description: input.description,
        severity: input.severity ?? null,
        user_id: user.id,
      }).catch((err) => {
        console.error("[createManualSignal] Failed to queue pipeline task:", err);
      });

      return signal;
    },

    updateSignalSeverity: async (
      _parent: unknown,
      args: { id: string; severity: number },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);

      const existing = await context.prisma.signals.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Signal not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.signals.update({
        where: { id: args.id },
        data: { severity: args.severity },
      });
    },

    deleteSignal: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.signals.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Signal not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.signals.delete({ where: { id: args.id } });
      return true;
    },
  },
  Signal: {
    source: (parent: { sourceId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.dataSources.findUnique({ where: { id: parent.sourceId } });
    },
    originLocation: (parent: { originId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.originId) return null;
      return prisma.locations.findUnique({ where: { id: parent.originId } });
    },
    destinationLocation: (parent: { destinationId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.destinationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.destinationId } });
    },
    generalLocation: (parent: { locationId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.locationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.locationId } });
    },
    events: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.signalEvents.findMany({
        where: { signalId: parent.id },
        include: { event: true },
      }).then((links) => links.map((l) => l.event));
    },
    feedbacks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userFeedbacks.findMany({ where: { signalId: parent.id } });
    },
    comments: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userComments.findMany({ where: { signalId: parent.id } });
    },
  },
};
