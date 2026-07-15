/**
 * Situation-analysis resolver.
 *
 * Query surface is deliberately narrow — the dashboard reads one
 * snapshot per (country, year), or a small history list for a
 * country. Everything expensive (LLM generation, RAG lookups) happens
 * in the Dagster asset ahead of time; the resolver only reads.
 *
 * Write path: `upsertSituationAnalysis` is called by the Dagster
 * `weekly_situation_analyses` asset. Bitemporal supersede-then-insert
 * inside one transaction — same pattern as
 * `refreshAggregatedDatapoints`.
 */

import { GraphQLError } from "graphql";
import type { Prisma } from "../generated/prisma/client.js";

import type { Context } from "../context.js";
import { requireContentReader, requireRole } from "../utils/auth-guard.js";

// Mirrors the SCHEMA_VERSION constant in
// `clear-context-pipeline/src/clear_context_pipeline/defs/situation/schemas.py`.
// Keep in sync when the Python side bumps.
const DEFAULT_SCHEMA_VERSION = "v1";

/** Compute Jan 1 → Dec 31 of `year` in UTC. Dashboard queries pass
 *  a year integer; we expand server-side so a client can't accidentally
 *  request a partial-year window that skips the pre-computed cache
 *  bucket. */
function calendarYearWindow(year: number): { windowStart: Date; windowEnd: Date } {
  return {
    windowStart: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
    windowEnd: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
  };
}

interface UpsertSituationAnalysisInput {
  countryLocationId: string;
  windowStart: Date;
  windowEnd: Date;
  data: Prisma.InputJsonValue;
  sourceReportIds: string[];
  aggregatedDatapointId?: string | null;
  generatedByModel: string;
  generationCostUsd?: number | null;
  schemaVersion: string;
}

export const situationAnalysisResolvers = {
  Query: {
    situationAnalysis: async (
      _parent: unknown,
      args: {
        countryLocationId: string;
        year?: number | null;
        asOf?: Date | null;
      },
      context: Context,
    ) => {
      requireContentReader(context);

      // Default to the current calendar year — the dashboard's
      // most common call passes no year at all and expects "now".
      const targetYear = args.year ?? new Date().getUTCFullYear();
      const { windowStart, windowEnd } = calendarYearWindow(targetYear);

      const asOf = args.asOf ?? new Date();

      // Bitemporal read — return the row whose validity window covers
      // asOf. Order-by validFrom desc handles a mid-transaction race
      // where two rows momentarily overlap (never expected but safe).
      return context.prisma.situationAnalysis.findFirst({
        where: {
          countryLocationId: args.countryLocationId,
          windowStart,
          windowEnd,
          schemaVersion: DEFAULT_SCHEMA_VERSION,
          validFrom: { lte: asOf },
          OR: [{ validTo: null }, { validTo: { gt: asOf } }],
        },
        orderBy: { validFrom: "desc" },
      });
    },

    situationAnalysesForCountry: async (
      _parent: unknown,
      args: { countryLocationId: string; limit?: number | null },
      context: Context,
    ) => {
      requireContentReader(context);

      // Trend view: current-version rows only, newest year first.
      // Bounded to keep a chart's data payload predictable — 5 rows
      // covers a rolling half-decade, which is the natural horizon
      // for situation-analysis comparisons.
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
      return context.prisma.situationAnalysis.findMany({
        where: {
          countryLocationId: args.countryLocationId,
          schemaVersion: DEFAULT_SCHEMA_VERSION,
          validTo: null,
        },
        orderBy: { windowStart: "desc" },
        take: limit,
      });
    },
  },

  Mutation: {
    upsertSituationAnalysis: async (
      _parent: unknown,
      args: { input: UpsertSituationAnalysisInput },
      context: Context,
    ): Promise<{
      situationAnalysisId: string;
      countryLocationId: string;
      supersededPrevious: boolean;
    }> => {
      requireRole(context, ["admin", "pipeline"]);
      const { input } = args;

      if (!input.countryLocationId || !input.schemaVersion) {
        throw new GraphQLError(
          "upsertSituationAnalysis: countryLocationId and schemaVersion are required",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      const now = new Date();

      return context.prisma.$transaction(async (tx) => {
        // Stamp validTo on the previous current row (if any) FIRST.
        // The partial unique index (WHERE valid_to IS NULL) rejects
        // the insert below unless the prior current row is already
        // stamped as superseded — ordering matters.
        const superseded = await tx.situationAnalysis.updateMany({
          where: {
            countryLocationId: input.countryLocationId,
            windowStart: input.windowStart,
            windowEnd: input.windowEnd,
            schemaVersion: input.schemaVersion,
            validTo: null,
          },
          data: { validTo: now },
        });

        const created = await tx.situationAnalysis.create({
          data: {
            countryLocationId: input.countryLocationId,
            windowStart: input.windowStart,
            windowEnd: input.windowEnd,
            data: input.data,
            sourceReportIds: input.sourceReportIds,
            aggregatedDatapointId: input.aggregatedDatapointId ?? null,
            generatedByModel: input.generatedByModel,
            generationCostUsd: input.generationCostUsd ?? null,
            schemaVersion: input.schemaVersion,
            validFrom: now,
          },
        });

        return {
          situationAnalysisId: created.id,
          countryLocationId: created.countryLocationId,
          supersededPrevious: superseded.count > 0,
        };
      });
    },
  },
};
