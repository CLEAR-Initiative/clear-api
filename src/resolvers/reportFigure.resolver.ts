/**
 * Report-figure resolver — the image asset store behind infographic capture.
 *
 *   - Query `reportFigures(...)` — retrieve captured figures filtered by the same
 *     params as text (location / event type / need sector / time / kind), so a
 *     figure can be attached to an answer scoped to a place + topic + period.
 *     Any authenticated content reader.
 *   - Mutation `upsertReportFigures(input)` — pipeline-only. Replaces a report's
 *     figures atomically (delete-then-insert), mirroring `upsertReportDatapoints`.
 */

import { GraphQLError } from "graphql";
import { Prisma } from "../generated/prisma/client.js";
import type { Context } from "../context.js";
import { requireContentReader, requireRole } from "../utils/auth-guard.js";

interface ReportFigureInput {
  pageNumber: number;
  bbox?: number[] | null;
  isFullPage?: boolean | null;
  s3Key: string;
  kind: string;
  title?: string | null;
  description?: string | null;
  transcription?: Prisma.InputJsonValue | null;
  sourceId?: string | null;
  locationIds?: string[] | null;
  locationPcodes?: string[] | null;
  eventTypes?: string[] | null;
  needSectors?: string[] | null;
  timeRangeStart?: Date | null;
  timeRangeEnd?: Date | null;
}

interface UpsertReportFiguresInput {
  reportId: string;
  reportTitle: string;
  sourceUrl: string;
  extractedByModel: string;
  figures: ReportFigureInput[];
}

// kinds we store. `logo` is dropped by the pipeline before it ever reaches here.
const VALID_KINDS = new Set(["chart", "map", "table", "infographic", "photo"]);

export const reportFigureResolvers = {
  Query: {
    reportFigures: async (
      _parent: unknown,
      args: {
        reportId?: string | null;
        locationIds?: string[] | null;
        eventTypes?: string[] | null;
        needSectors?: string[] | null;
        kinds?: string[] | null;
        timeRangeStart?: Date | null;
        timeRangeEnd?: Date | null;
        first?: number | null;
      },
      context: Context,
    ) => {
      requireContentReader(context);
      const take = Math.min(Math.max(args.first ?? 50, 1), 200);

      // Array filters use `hasSome` (GIN-indexed) — a figure matches if it carries
      // ANY of the requested location/type/sector tags. Time overlaps the window.
      const where: Prisma.reportFigureWhereInput = {};
      if (args.reportId) where.reportId = args.reportId;
      if (args.locationIds?.length) where.locationIds = { hasSome: args.locationIds };
      if (args.eventTypes?.length) where.eventTypes = { hasSome: args.eventTypes };
      if (args.needSectors?.length) where.needSectors = { hasSome: args.needSectors };
      if (args.kinds?.length) where.kind = { in: args.kinds };
      // Overlap: figure's [start,end] intersects the requested window.
      if (args.timeRangeStart) where.timeRangeEnd = { gte: args.timeRangeStart };
      if (args.timeRangeEnd) where.timeRangeStart = { lte: args.timeRangeEnd };

      return context.prisma.reportFigure.findMany({
        where,
        orderBy: [{ extractedAt: "desc" }, { pageNumber: "asc" }],
        take,
      });
    },
  },

  Mutation: {
    upsertReportFigures: async (
      _parent: unknown,
      args: { input: UpsertReportFiguresInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const { input } = args;
      if (!input.reportId) {
        throw new GraphQLError("upsertReportFigures: reportId is required", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      for (const f of input.figures) {
        if (!VALID_KINDS.has(f.kind)) {
          throw new GraphQLError(
            `Invalid figure kind "${f.kind}". One of: ${[...VALID_KINDS].join(", ")}.`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
      }

      // Replace-on-reingest: a re-extraction of the report supersedes its figures
      // wholesale, so a removed figure never lingers. Same posture as datapoints.
      const written = await context.prisma.$transaction(async (tx) => {
        await tx.reportFigure.deleteMany({ where: { reportId: input.reportId } });
        if (input.figures.length === 0) return 0;
        const result = await tx.reportFigure.createMany({
          data: input.figures.map((f) => ({
            reportId: input.reportId,
            reportTitle: input.reportTitle,
            sourceUrl: input.sourceUrl,
            extractedByModel: input.extractedByModel,
            pageNumber: f.pageNumber,
            bbox: f.bbox ?? [],
            isFullPage: f.isFullPage ?? false,
            s3Key: f.s3Key,
            kind: f.kind,
            title: f.title ?? null,
            description: f.description ?? null,
            transcription: (f.transcription ?? undefined) as Prisma.InputJsonValue | undefined,
            sourceId: f.sourceId ?? null,
            locationIds: f.locationIds ?? [],
            locationPcodes: f.locationPcodes ?? [],
            eventTypes: f.eventTypes ?? [],
            needSectors: f.needSectors ?? [],
            timeRangeStart: f.timeRangeStart ?? null,
            timeRangeEnd: f.timeRangeEnd ?? null,
          })),
        });
        return result.count;
      });

      return { reportId: input.reportId, count: written };
    },
  },
};
