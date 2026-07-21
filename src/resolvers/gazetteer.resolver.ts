import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";
import { normalizeGazetteerName } from "../utils/geonames-normalize.js";

interface Row {
  geonamesId: number;
  name: string;
  latitude: number;
  longitude: number;
  featureClass: string | null;
  featureCode: string | null;
  countryCode: string;
  population: bigint;
  sim?: number;
}

function toHit(r: Row, score: number, exact: boolean) {
  return {
    geonamesId: r.geonamesId,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    featureClass: r.featureClass,
    featureCode: r.featureCode,
    countryCode: r.countryCode,
    population: Number(r.population),
    score,
    exact,
  };
}

export const gazetteerResolvers = {
  Query: {
    resolveGazetteerLocation: async (
      _parent: unknown,
      args: { name: string; countryCode?: string | null; minSimilarity?: number | null },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);

      const q = normalizeGazetteerName(args.name);
      if (!q) return null;
      const cc = args.countryCode ? args.countryCode.toUpperCase() : null;
      // Clamp to pg_trgm's valid [0, 1] range — the field is a GraphQL Float,
      // so a caller could pass -1 (which would disable the floor entirely) or
      // >1 (which would match nothing). Defaults to 0.4.
      const minSim = Math.min(1, Math.max(0, args.minSimilarity ?? 0.4));

      // 1. Exact normalised-name hit. Prefer populated places / admin areas
      //    over hydro/terrain/POI features, then the most-populous tie-break.
      const exact = await context.prisma.$queryRaw<Row[]>`
        SELECT g.geonames_id AS "geonamesId", g.name, g.latitude, g.longitude,
               g.feature_class AS "featureClass", g.feature_code AS "featureCode",
               g.country_code AS "countryCode", g.population
        FROM "geonames_name" n
        JOIN "geonames" g ON g.geonames_id = n.geonames_id
        WHERE n.name_norm = ${q}
          AND (${cc}::text IS NULL OR n.country_code = ${cc})
        ORDER BY (g.feature_class IN ('P', 'A')) DESC, g.population DESC
        LIMIT 1
      `;
      if (exact.length > 0) return toHit(exact[0], 1.0, true);

      // 2. Fuzzy trigram fallback, GIN-indexed via the `%` operator.
      //    `%` prunes by pg_trgm's similarity-threshold GUC, NOT by any
      //    value in the query — its default is 0.3, so a caller passing
      //    minSimilarity < 0.3 would otherwise still be floored at 0.3 with
      //    no error. Lower the threshold to minSim for this query only:
      //    set_config(..., is_local => true) scopes it to the transaction so
      //    it reverts on commit and can't leak onto the pooled connection.
      //    With `%` now honouring minSim, the explicit `>= minSim` filter is
      //    redundant and `similarity()` is computed once (aliased `sim`).
      const fuzzy = await context.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('pg_trgm.similarity_threshold', ${minSim}::text, true)`;
        return tx.$queryRaw<Row[]>`
          SELECT g.geonames_id AS "geonamesId", g.name, g.latitude, g.longitude,
                 g.feature_class AS "featureClass", g.feature_code AS "featureCode",
                 g.country_code AS "countryCode", g.population,
                 similarity(n.name_norm, ${q}) AS sim
          FROM "geonames_name" n
          JOIN "geonames" g ON g.geonames_id = n.geonames_id
          WHERE (${cc}::text IS NULL OR n.country_code = ${cc})
            AND n.name_norm % ${q}
          ORDER BY sim DESC, (g.feature_class IN ('P', 'A')) DESC, g.population DESC
          LIMIT 1
        `;
      });
      if (fuzzy.length > 0) return toHit(fuzzy[0], Number(fuzzy[0].sim), false);

      return null;
    },
  },
};
