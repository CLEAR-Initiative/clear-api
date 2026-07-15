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

// Reads resolve the schema version from the data rather than pinning a
// constant. The pipeline
// (`clear-context-pipeline/.../situation/schemas.py`) owns SCHEMA_VERSION
// and bumps it independently; a constant here would mean writes keep
// succeeding while every read returns null — an empty dashboard with no
// signal, until someone remembers to bump a constant in another repo and
// redeploy. That lockstep is not enforceable across repos, so don't
// reintroduce it.

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
        schemaVersion?: string | null;
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
      //
      // Schema version: pin it if the caller asked for one, otherwise the
      // newest write wins. Versions coexist rather than supersede — the
      // uniqueness index is per-version, so a v1 and a v2 row can both be
      // current for one bucket, and a client that wants the older payload
      // shape can still ask for it. The client reads `schemaVersion` off
      // the row to know what it got.
      return context.prisma.situationAnalysis.findFirst({
        where: {
          countryLocationId: args.countryLocationId,
          windowStart,
          windowEnd,
          ...(args.schemaVersion ? { schemaVersion: args.schemaVersion } : {}),
          validFrom: { lte: asOf },
          OR: [{ validTo: null }, { validTo: { gt: asOf } }],
        },
        orderBy: { validFrom: "desc" },
      });
    },

    situationAnalysesForCountry: async (
      _parent: unknown,
      args: {
        countryLocationId: string;
        limit?: number | null;
        schemaVersion?: string | null;
      },
      context: Context,
    ) => {
      requireContentReader(context);

      // Trend view: current rows of a SINGLE schema version, newest year
      // first. A trend must not mix versions — a bump changes what the
      // numbers mean, so a chart spanning v1 and v2 rows would plot two
      // different quantities as one series. That constraint is about
      // mixing, not about which version: pin it if the caller asked,
      // otherwise default to the country's most recently written one.
      // Older versions stay queryable — pass `schemaVersion` to chart a
      // historical payload shape.
      //
      // Bounded to keep a chart's data payload predictable — 5 rows
      // covers a rolling half-decade, which is the natural horizon
      // for situation-analysis comparisons.
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);

      let schemaVersion = args.schemaVersion ?? null;
      if (!schemaVersion) {
        const newest = await context.prisma.situationAnalysis.findFirst({
          where: { countryLocationId: args.countryLocationId, validTo: null },
          orderBy: { validFrom: "desc" },
          select: { schemaVersion: true },
        });
        if (!newest) return [];
        schemaVersion = newest.schemaVersion;
      }

      return context.prisma.situationAnalysis.findMany({
        where: {
          countryLocationId: args.countryLocationId,
          schemaVersion,
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
