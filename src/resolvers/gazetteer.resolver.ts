import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";

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

/**
 * unaccent + lowercase + strip punctuation. MUST stay in lockstep with the
 * normaliser in `scripts/import-geonames.ts` — the stored `name_norm` is
 * produced there, so a divergence here silently breaks every lookup.
 */
function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

      const q = norm(args.name);
      if (!q) return null;
      const cc = args.countryCode ? args.countryCode.toUpperCase() : null;
      const minSim = args.minSimilarity ?? 0.4;

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

      // 2. Fuzzy trigram fallback. The `%` operator is GIN-indexed
      //    (pg_trgm) and prunes to the session similarity threshold; the
      //    explicit `>= minSim` raises the floor. Ranked by similarity,
      //    then settlement importance.
      const fuzzy = await context.prisma.$queryRaw<Row[]>`
        SELECT g.geonames_id AS "geonamesId", g.name, g.latitude, g.longitude,
               g.feature_class AS "featureClass", g.feature_code AS "featureCode",
               g.country_code AS "countryCode", g.population,
               similarity(n.name_norm, ${q}) AS sim
        FROM "geonames_name" n
        JOIN "geonames" g ON g.geonames_id = n.geonames_id
        WHERE (${cc}::text IS NULL OR n.country_code = ${cc})
          AND n.name_norm % ${q}
          AND similarity(n.name_norm, ${q}) >= ${minSim}
        ORDER BY sim DESC, (g.feature_class IN ('P', 'A')) DESC, g.population DESC
        LIMIT 1
      `;
      if (fuzzy.length > 0) return toHit(fuzzy[0], Number(fuzzy[0].sim), false);

      return null;
    },
  },
};
