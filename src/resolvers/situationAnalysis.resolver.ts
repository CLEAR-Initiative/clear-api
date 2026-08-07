/**
 * Situation-analysis resolver.
 *
 * Query surface is deliberately narrow - the dashboard reads one
 * snapshot per bucket (yearly by default, or an explicit
 * windowKind + windowStart), or a small history list for a country.
 * Everything expensive (LLM generation, RAG lookups) happens in the
 * Dagster asset ahead of time; the resolver only reads.
 *
 * Write path: `upsertSituationAnalysis` is called by the Dagster
 * `weekly_situation_analyses` asset. Bitemporal supersede-then-insert
 * inside one transaction - same pattern as
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
// succeeding while every read returns null - an empty dashboard with no
// signal, until someone remembers to bump a constant in another repo and
// redeploy. That lockstep is not enforceable across repos, so don't
// reintroduce it.

const YEARLY = "yearly";

/** Jan 1 of `year`, UTC. Dashboard queries pass a year integer; we expand
 *  server-side so a client can't accidentally request a partial-year
 *  window that skips the pre-computed cache bucket.
 *
 *  Only the START is derived. Reads key on
 *  (countryLocationId, windowKind, windowStart) - never on windowEnd.
 *  windowEnd is a derived detail that the pipeline and this resolver each
 *  compute independently, in different languages: the writer produced
 *  23:59:59.000 and this file used to look for 23:59:59.999, so exact
 *  equality never matched and every read returned null while every write
 *  succeeded. windowStart has no such ambiguity - both sides agree on
 *  midnight - and windowKind carries the granularity explicitly rather
 *  than implying it from a pair of timestamps. */
function calendarYearStart(year: number): Date {
  return new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
}

interface UpsertSituationAnalysisInput {
  countryLocationId: string;
  windowStart: Date;
  windowEnd: Date;
  windowKind: string;
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
        windowKind?: string | null;
        windowStart?: Date | null;
        asOf?: Date | null;
        schemaVersion?: string | null;
      },
      context: Context,
    ) => {
      requireContentReader(context);

      const windowKind = args.windowKind ?? YEARLY;

      // Two ways to name a bucket. The dashboard passes a year (or
      // nothing) and gets the yearly bucket; the pipeline passes the
      // windowKind + windowStart it computed, which is the only way to
      // reach a finer bucket. `year` cannot identify one - Jan 1 is a
      // valid start for both the yearly and the January monthly bucket -
      // so rather than derive a start that silently matches the wrong
      // row, require the caller to be explicit.
      let windowStart: Date;
      if (args.windowStart) {
        windowStart = args.windowStart;
      } else if (windowKind === YEARLY) {
        windowStart = calendarYearStart(args.year ?? new Date().getUTCFullYear());
      } else {
        throw new GraphQLError(
          `situationAnalysis: windowStart is required when windowKind is "${windowKind}" (only "${YEARLY}" can be derived from year)`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      const asOf = args.asOf ?? new Date();

      // Bitemporal read - return the row whose validity window covers
      // asOf. Order-by validFrom desc handles a mid-transaction race
      // where two rows momentarily overlap (never expected but safe).
      //
      // Schema version: pin it if the caller asked for one, otherwise the
      // newest write wins. Versions coexist rather than supersede - the
      // uniqueness index is per-version, so rows of two schema versions can
      // both be current for one bucket, and a client that wants the older payload
      // shape can still ask for it. The client reads `schemaVersion` off
      // the row to know what it got.
      return context.prisma.situationAnalysis.findFirst({
        where: {
          countryLocationId: args.countryLocationId,
          windowKind,
          windowStart,
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
      // first. A trend must not mix versions - a bump changes what the
      // numbers mean, so a chart spanning two schema versions would plot two
      // different quantities as one series. That constraint is about
      // mixing, not about which version: pin it if the caller asked,
      // otherwise default to the country's most recently written one.
      // Older versions stay queryable - pass `schemaVersion` to chart a
      // historical payload shape.
      //
      // Scoped to yearly rows: one point per year is what a trend means
      // here, and a future monthly analysis must not silently interleave
      // itself into the same series.
      //
      // Bounded to keep a chart's data payload predictable - 5 rows
      // covers a rolling half-decade, which is the natural horizon
      // for situation-analysis comparisons.
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);

      let schemaVersion = args.schemaVersion ?? null;
      if (!schemaVersion) {
        const newest = await context.prisma.situationAnalysis.findFirst({
          where: {
            countryLocationId: args.countryLocationId,
            windowKind: YEARLY,
            validTo: null,
          },
          orderBy: { validFrom: "desc" },
          select: { schemaVersion: true },
        });
        if (!newest) return [];
        schemaVersion = newest.schemaVersion;
      }

      return context.prisma.situationAnalysis.findMany({
        where: {
          countryLocationId: args.countryLocationId,
          windowKind: YEARLY,
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

      // windowKind is part of the bucket key, so a wrong value writes a
      // row no reader will ever ask for. Reject rather than default: the
      // pipeline knows its own granularity, and a silent default is what
      // lets a write land somewhere nobody reads.
      const windowKind = input.windowKind;
      if (!windowKind) {
        throw new GraphQLError(
          "upsertSituationAnalysis: windowKind is required",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      const now = new Date();

      return context.prisma.$transaction(async (tx) => {
        // Stamp validTo on the previous current row (if any) FIRST.
        // The partial unique index (WHERE valid_to IS NULL) rejects
        // the insert below unless the prior current row is already
        // stamped as superseded - ordering matters.
        // Supersede on the same key the unique index enforces -
        // (country, windowKind, windowStart, schemaVersion). windowEnd is
        // deliberately absent: it is a derived detail, and including it
        // here would mean a writer that shifted its end-of-day by a
        // millisecond would fail to supersede its own previous row and
        // then collide with it on insert.
        const superseded = await tx.situationAnalysis.updateMany({
          where: {
            countryLocationId: input.countryLocationId,
            windowKind,
            windowStart: input.windowStart,
            schemaVersion: input.schemaVersion,
            validTo: null,
          },
          data: { validTo: now },
        });

        const created = await tx.situationAnalysis.create({
          data: {
            countryLocationId: input.countryLocationId,
            windowKind,
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
