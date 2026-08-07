import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";

interface CreateDataSourceInput {
  name: string;
  type: string;
  isActive?: boolean;
  baseUrl?: string;
  infoUrl?: string;
  synonyms?: string[];
  reliability?: number | null;
}

interface UpdateDataSourceInput {
  name?: string;
  type?: string;
  isActive?: boolean;
  baseUrl?: string;
  infoUrl?: string;
  synonyms?: string[];
  reliability?: number | null;
}

/**
 * Append `name` as a synonym of the given source, unless it already appears
 * (case-insensitively) as the canonical name or an existing synonym. Called
 * after a URL or fuzzy match so the next lookup for that spelling hits exactly.
 * `synonyms` defaults to `[]` (never NULL), so `array_append` is always safe —
 * `array_append(NULL, x)` would silently yield NULL.
 */
async function appendSynonym(
  prisma: Context["prisma"],
  id: string,
  name: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "data_sources"
    SET "synonyms" = array_append("synonyms", ${name}), "updated_at" = now()
    WHERE "id" = ${id}
      AND lower(${name}) <> lower("name")
      AND NOT EXISTS (SELECT 1 FROM unnest("synonyms") s WHERE lower(s) = lower(${name}))
  `;
}

export const dataSourceResolvers = {
  Query: {
    // Registry metadata, not content: gated with bare requireAuth (like
    // pipelineCountries) rather than requireContentReader, so every
    // authenticated principal — session users of any role and M2M API
    // keys regardless of the owning service account's role — keeps
    // access. requireContentReader would silently break any service key
    // whose account is ever moved to the `pipeline` role.
    dataSources: (_parent: unknown, _args: unknown, context: Context) => {
      requireAuth(context);
      return context.prisma.dataSources.findMany();
    },
    dataSource: (_parent: unknown, args: { id: string }, context: Context) => {
      requireAuth(context);
      return context.prisma.dataSources.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createDataSource: async (
      _parent: unknown,
      args: { input: CreateDataSourceInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { input } = args;

      return context.prisma.dataSources.create({
        data: {
          name: input.name,
          type: input.type,
          isActive: input.isActive ?? true,
          baseUrl: input.baseUrl,
          infoUrl: input.infoUrl,
          synonyms: input.synonyms ?? undefined,
          reliability: input.reliability ?? undefined,
        },
      });
    },

    updateDataSource: async (
      _parent: unknown,
      args: { id: string; input: UpdateDataSourceInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { id, input } = args;

      const existing = await context.prisma.dataSources.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("DataSource not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.dataSources.update({
        where: { id },
        data: {
          name: input.name ?? undefined,
          type: input.type ?? undefined,
          isActive: input.isActive ?? undefined,
          baseUrl: input.baseUrl,
          infoUrl: input.infoUrl,
          synonyms: input.synonyms ?? undefined,
          reliability: input.reliability ?? undefined,
        },
      });
    },

    deleteDataSource: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.dataSources.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("DataSource not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.dataSources.delete({ where: { id: args.id } });
      return true;
    },

    /**
     * Resolve an organisation/source name to a `data_sources` id, creating an
     * ungraded row if none matches. Mirrors `resolveKnowledgebaseLocation` — the
     * pipeline calls it during enrich/datapoint extraction so every figure's
     * cited source (and each report's publisher) lands on one canonical row.
     * Matching order (clear-context-pipeline ADR-0004 §2): exact name/synonym → infoUrl → fuzzy → create.
     *
     * Operates ONLY on `type = 'organisation'` rows: the automated feed rows
     * (dtm/acled/gdacs/dataminr = "api", field_officer = "manual") referenced by
     * `signals.sourceId` are never matched or mutated, so report attribution
     * stays cleanly separate from signal ingestion even when names/synonyms
     * overlap (the seed keeps an org "IOM DTM" alongside the api "dtm" feed).
     */
    resolveDataSource: async (
      _parent: unknown,
      args: { name: string; homepage?: string | null; minSimilarity?: number | null },
      context: Context,
    ): Promise<string> => {
      requireRole(context, ["admin", "pipeline"]);

      const name = args.name.trim();
      if (!name) {
        throw new GraphQLError("resolveDataSource: name must not be empty", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      const homepage = args.homepage?.trim() || null;
      // pg_trgm similarity lives in [0, 1]; clamp so a caller can't disable the
      // floor (negative) or make it unmatchable (>1). clear-context-pipeline ADR-0004 baseline 0.6.
      const minSim = Math.min(1, Math.max(0, args.minSimilarity ?? 0.6));
      const { prisma } = context;

      // 1. Exact match on the canonical name OR any synonym (case-insensitive).
      const exact = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "data_sources"
        WHERE "type" = 'organisation'
          AND (lower("name") = lower(${name})
               OR EXISTS (SELECT 1 FROM unnest("synonyms") s WHERE lower(s) = lower(${name})))
        LIMIT 1
      `;
      if (exact.length > 0) return exact[0]!.id;

      // 2. Same org under a new name: match on the homepage (infoUrl). Only the
      //    publisher carries a homepage; the LLM-cited source has none. Append
      //    the incoming name as a synonym so future lookups hit exactly at (1).
      if (homepage) {
        const byUrl = await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "data_sources"
          WHERE "type" = 'organisation'
            AND "url_info" IS NOT NULL AND "url_info" = ${homepage}
          LIMIT 1
        `;
        if (byUrl.length > 0) {
          const id = byUrl[0]!.id;
          await appendSynonym(prisma, id, name);
          return id;
        }
      }

      // 3. Fuzzy trigram match on name + synonyms. `data_sources` is a small
      //    registry, so a seq scan computing similarity() directly is cheap —
      //    no GIN index / threshold GUC needed (cf. gazetteer's large table).
      const fuzzy = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM (
          SELECT "id", GREATEST(
            similarity(lower("name"), lower(${name})),
            COALESCE((SELECT max(similarity(lower(s), lower(${name})))
                      FROM unnest("synonyms") s), 0)
          ) AS sim
          FROM "data_sources"
          WHERE "type" = 'organisation'
        ) t
        WHERE sim >= ${minSim}
        ORDER BY sim DESC
        LIMIT 1
      `;
      if (fuzzy.length > 0) {
        const id = fuzzy[0]!.id;
        await appendSynonym(prisma, id, name);
        return id;
      }

      // 4. No match → create an ungraded organisation row (reliability NULL →
      //    treated as 1 by the data-quality formula until a human grades it).
      const created = await prisma.dataSources.create({
        data: {
          name,
          type: "organisation",
          infoUrl: homepage ?? undefined,
        },
      });
      return created.id;
    },
  },
  DataSource: {
    signals: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.signals.findMany({ where: { sourceId: parent.id } });
    },
  },
};
