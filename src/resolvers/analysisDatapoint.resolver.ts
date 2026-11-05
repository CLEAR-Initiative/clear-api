import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";

interface UpsertAnalysisDatapointsInput {
  analysisId: string;
  data: unknown;
  contributingReportIds: string[];
  origin?: string | null;
  newestSourceAt?: string | null;
  oldestSourceAt?: string | null;
  dataQualityScore?: number | null;
  reportCount?: number | null;
  schemaVersion: string;
}

export const analysisDatapointResolvers = {
  Mutation: {
    upsertAnalysisDatapoints: async (
      _parent: unknown,
      args: { input: UpsertAnalysisDatapointsInput },
      context: Context,
    ): Promise<{
      analysisId: string;
      schemaVersion: string;
      createdOrReplaced: boolean;
    }> => {
      // Pipeline (or admin) only — the Dagster analysis_numbers_extract asset
      // is the caller; symmetric with upsertReportDatapoints.
      requireRole(context, ["admin", "pipeline"]);
      const { input } = args;

      if (!input.analysisId || !input.schemaVersion) {
        throw new GraphQLError(
          "upsertAnalysisDatapoints: analysisId and schemaVersion are required",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      // The analysis must exist — analysis_id is a non-null FK and the row is
      // owned by its generation. A clear 400 beats a raw FK violation.
      const analysis = await context.prisma.analysis.findUnique({
        where: { id: input.analysisId },
        select: { id: true },
      });
      if (!analysis) {
        throw new GraphQLError(
          `upsertAnalysisDatapoints: analysis ${input.analysisId} not found`,
          { extensions: { code: "NOT_FOUND" } },
        );
      }

      // Replace-in-place keyed on the unique analysis_id. Detect create vs
      // replace up front so the caller can log accurately.
      const existing = await context.prisma.analysisDatapoint.findUnique({
        where: { analysisId: input.analysisId },
        select: { id: true },
      });

      const fields = {
        data: input.data as object,
        contributingReportIds: input.contributingReportIds,
        origin: input.origin ?? null,
        newestSourceAt: input.newestSourceAt ? new Date(input.newestSourceAt) : null,
        oldestSourceAt: input.oldestSourceAt ? new Date(input.oldestSourceAt) : null,
        dataQualityScore: input.dataQualityScore ?? null,
        reportCount: input.reportCount ?? null,
        schemaVersion: input.schemaVersion,
      } as const;

      await context.prisma.analysisDatapoint.upsert({
        where: { analysisId: input.analysisId },
        create: { analysisId: input.analysisId, ...fields },
        // computed_at uses @default(now()); the update path doesn't touch it
        // unless set, so stamp a fresh timestamp on replace.
        update: { ...fields, computedAt: new Date() },
      });

      return {
        analysisId: input.analysisId,
        schemaVersion: input.schemaVersion,
        createdOrReplaced: existing !== null,
      };
    },
  },
};
