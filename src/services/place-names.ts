import { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { hasArabic, normalizeGazetteerName } from "../utils/geonames-normalize.js";

/**
 * Place aliases and the unresolved place-name queue (ADR-0019): the lookup
 * the gazetteer runs first, the suggestions a decider sees, and the write
 * that turns an answer into an alias and moves the waiting Signals.
 */

/** A Prisma client or an open transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

// ─── Alias lookup (the gazetteer's first tier) ───────────────────────────────

export interface AliasHit {
  aliasId: string;
  locationId: string;
  name: string;
  geonamesId: number | null;
  latitude: number;
  longitude: number;
  countryCode: string;
}

/** A point for a location: the point itself, or a point on a polygon. */
const POINT_OF_L = Prisma.sql`
  CASE WHEN GeometryType(l."geometry") = 'POINT' THEN l."geometry"
       ELSE ST_PointOnSurface(l."geometry") END`;

/**
 * The alias for a normalised spelling, or null. An alias applies when it is
 * country-wide (no scope), or when its scope is `withinLocationId` or holds
 * it. A scoped alias wins over a country-wide one. The alias location is not
 * tested against `withinLocationId`: the caller checks the point it gets, as
 * it does for a GeoNames hit.
 */
export async function findPlaceAlias(
  prisma: Db,
  nameNorm: string,
  countryCode: string | null,
  withinLocationId: string | null,
): Promise<AliasHit | null> {
  const rows = await prisma.$queryRaw<AliasHit[]>`
    SELECT a."id" AS "aliasId", l."id" AS "locationId", l."name", l."geonames_id" AS "geonamesId",
           ST_Y(p.pt) AS "latitude", ST_X(p.pt) AS "longitude", a."country_code" AS "countryCode"
    FROM "place_aliases" a
    JOIN "locations" l ON l."id" = a."location_id"
    CROSS JOIN LATERAL (SELECT ${POINT_OF_L} AS pt) p
    WHERE a."name_norm" = ${nameNorm}
      AND (${countryCode}::text IS NULL OR a."country_code" = ${countryCode})
      AND (
        a."scope_location_id" IS NULL
        OR a."scope_location_id" = ${withinLocationId}::text
        OR a."scope_location_id" = ANY(
          COALESCE((SELECT w."ancestor_ids" FROM "locations" w WHERE w."id" = ${withinLocationId}::text), ARRAY[]::text[])
        )
      )
    ORDER BY (a."scope_location_id" IS NOT NULL) DESC, a."created_at" ASC
    LIMIT 1`;
  return rows[0] ?? null;
}

// ─── Suggestions ─────────────────────────────────────────────────────────────

/**
 * A CLEAR location's name, normalised in SQL the way `normalizeGazetteerName`
 * normalises the query: lower case, Arabic spelling variants folded to one
 * letter, vowel marks and tatweel removed, punctuation reduced to spaces.
 * `locations.name` is stored as written (GeoNames names are stored
 * normalised), so without this an Arabic landmark name never equals its own
 * normalised spelling. Latin accents are not folded here: Postgres has no
 * NFKD, and CLEAR's Latin names are plain.
 */
const NORM_L_NAME = Prisma.sql`btrim(regexp_replace(regexp_replace(
  translate(lower(l."name"), 'أإآٱىیکةؤئ', 'ااااييكهوي'),
  '[\u064B-\u065F\u0670\u0640]', '', 'g'),
  '[^a-z0-9 \u0621-\u064A\u066E-\u06D3]+', ' ', 'g'))`;

export interface PlaceNameSuggestion {
  kind: "GEONAMES" | "LOCATION";
  geonamesId: number | null;
  locationId: string | null;
  name: string;
  /** `locations.level` of a CLEAR location (2 district, 4 landmark). */
  level: number | null;
  featureClass: string | null;
  featureCode: string | null;
  latitude: number;
  longitude: number;
  /** 0 to 1: trigram similarity to the name, 1 for an exact match. */
  score: number;
  /** Whether the point is inside `withinLocationId`. Null without one. */
  insideArea: boolean | null;
  /** Kilometres from `withinLocationId` (0 inside it). Null without one. */
  distanceKm: number | null;
}

/** Trigram floor for suggestions: low, because a person reads the list. */
const SUGGESTION_MIN_SIMILARITY = 0.2;
const SUGGESTIONS_PER_KIND = 5;

/**
 * Up to 5 GeoNames candidates and up to 5 CLEAR districts or landmarks with
 * a name like `name` (or exactly `nameAr`), in one country. Candidates
 * inside `withinLocationId` come first, then the most similar, then the
 * nearest. Computed on demand: nothing is stored on the queue row.
 */
export async function suggestPlaces(
  prisma: PrismaClient,
  args: {
    name: string;
    nameAr?: string | null;
    countryCode: string;
    countryLocationId: string | null;
    withinLocationId: string | null;
  },
): Promise<PlaceNameSuggestion[]> {
  const q = normalizeGazetteerName(args.name);
  const qAr = args.nameAr ? normalizeGazetteerName(args.nameAr) : "";
  // Arabic matches exactly or not at all: trigrams over short Arabic words
  // are too coarse (the gazetteer resolver's rule).
  const fuzzy = q && !hasArabic(q) ? q : null;
  const exact = [q, qAr].filter((s) => s.length > 0);
  if (exact.length === 0) return [];
  const within = args.withinLocationId;

  const area = Prisma.sql`(SELECT w."geometry" FROM "locations" w WHERE w."id" = ${within}::text)`;
  const measure = (pt: Prisma.Sql) => Prisma.sql`
    CASE WHEN ${within}::text IS NULL THEN NULL ELSE COALESCE(ST_Contains(${area}, ${pt}), FALSE) END AS "insideArea",
    CASE WHEN ${within}::text IS NULL THEN NULL
         ELSE ST_Distance(${area}::geography, ${pt}::geography) / 1000.0 END AS "distanceKm"`;
  const order = Prisma.sql`"insideArea" DESC NULLS LAST, "score" DESC, "distanceKm" ASC NULLS LAST`;

  return prisma.$transaction(async (tx) => {
    // `%` prunes by this setting, not by a value in the query. Local to the
    // transaction, so it cannot leak onto the pooled connection.
    await tx.$executeRaw`SELECT set_config('pg_trgm.similarity_threshold', ${String(SUGGESTION_MIN_SIMILARITY)}, true)`;

    const geonames = await tx.$queryRaw<PlaceNameSuggestion[]>`
      WITH matched AS (
        SELECT DISTINCT ON (g."geonames_id")
               g."geonames_id" AS "geonamesId", g."name", g."feature_class" AS "featureClass",
               g."feature_code" AS "featureCode", g."latitude", g."longitude",
               CASE WHEN n."name_norm" = ANY(${exact}::text[]) THEN 1.0
                    ELSE similarity(n."name_norm", ${fuzzy ?? ""}) END AS "score"
        FROM "geonames_name" n
        JOIN "geonames" g ON g."geonames_id" = n."geonames_id"
        WHERE n."country_code" = ${args.countryCode}
          AND (n."name_norm" = ANY(${exact}::text[])
               OR (${fuzzy}::text IS NOT NULL AND n."name_norm" % ${fuzzy ?? ""}))
        ORDER BY g."geonames_id", "score" DESC
      )
      SELECT 'GEONAMES' AS "kind", m."geonamesId", NULL AS "locationId", m."name", NULL::int AS "level",
             m."featureClass", m."featureCode", m."latitude", m."longitude", m."score"::float8 AS "score",
             ${measure(Prisma.sql`ST_SetSRID(ST_MakePoint(m."longitude", m."latitude"), 4326)`)}
      FROM matched m
      ORDER BY ${order}, m."geonamesId" ASC
      LIMIT ${SUGGESTIONS_PER_KIND}`;

    // CLEAR districts and named landmarks of the same country. A point made
    // from bare coordinates ("Point 12.89, 23.47") names no place.
    const locations = args.countryLocationId
      ? await tx.$queryRaw<PlaceNameSuggestion[]>`
          WITH matched AS (
            SELECT l."id", l."name", l."level", ${POINT_OF_L} AS pt,
                   CASE WHEN ${NORM_L_NAME} = ANY(${exact}::text[]) THEN 1.0
                        ELSE similarity(${NORM_L_NAME}, ${fuzzy ?? ""}) END AS "score"
            FROM "locations" l
            WHERE l."ancestor_ids" @> ARRAY[${args.countryLocationId}]::text[]
              AND (l."level" = 2 OR (l."level" = 4 AND l."point_type" = 'landmark-geocoded'))
              AND l."geometry" IS NOT NULL
              AND l."name" !~* '^point -?[0-9]'
          )
          SELECT 'LOCATION' AS "kind", NULL::int AS "geonamesId", m."id" AS "locationId", m."name", m."level",
                 NULL AS "featureClass", NULL AS "featureCode",
                 ST_Y(m.pt) AS "latitude", ST_X(m.pt) AS "longitude", m."score"::float8 AS "score",
                 ${measure(Prisma.sql`m.pt`)}
          FROM matched m
          WHERE m."score" >= ${SUGGESTION_MIN_SIMILARITY}
          ORDER BY ${order}, m."id" ASC
          LIMIT ${SUGGESTIONS_PER_KIND}`
      : [];

    // Each kind keeps its own five; the list a decider reads is ranked as
    // one: inside the area first, then the most similar, then the nearest.
    return [...geonames, ...locations].sort(bySuggestionRank);
  });
}

/** Inside the area first, then the most similar, then the nearest. */
export function bySuggestionRank(a: PlaceNameSuggestion, b: PlaceNameSuggestion): number {
  const inside = Number(b.insideArea === true) - Number(a.insideArea === true);
  if (inside !== 0) return inside;
  if (b.score !== a.score) return b.score - a.score;
  return (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY);
}

// ─── Resolve into an alias, and move the waiting Signals ─────────────────────

/** Statuses a decider may still resolve. An ambiguous row waits for someone
 *  with local knowledge, so it stays resolvable. */
export const RESOLVABLE_STATUSES = ["open", "ambiguous"] as const;

export class PlaceNameConflict extends Error {
  constructor(public readonly reason: "ROW_CLOSED" | "ALIAS_EXISTS") {
    super(reason);
  }
}

export interface ResolveIntoAliasArgs {
  row: {
    id: string;
    nameNorm: string;
    nameAsWritten: string;
    nameAr: string | null;
    countryCode: string;
    stateLocationId: string | null;
    /** The status the caller read. The write goes through only while the
     *  row still has it: a decision made in between is a conflict, also one
     *  that left the row resolvable (open to ambiguous). */
    status: string;
  };
  /** The CLEAR location the spelling means. */
  locationId: string;
  userId: string;
  note: string | null;
  /** "review" from the queue; "manual" when an alias made by hand closes a row. */
  source: "review" | "manual";
  /** An alias that exists already (the alias API). Omitted: one is created. */
  aliasId?: string;
  now?: Date;
}

/**
 * In ONE transaction: close the queue row as resolved, write the alias (and
 * a second alias for the row's Arabic spelling), and move the waiting
 * Signals to the alias location.
 *
 * A Signal moves when the alias location is inside the Signal's current
 * location (so its country and state stay as they are) and no person has
 * corrected the Signal (`locationCorrectedAt`): a human correction always
 * wins. `pipelineLocationId` and `locationCorrectedAt` are not written: the
 * move is the gazetteer's answer arriving late, not a correction. Which
 * Event the Signal belongs to does not change.
 *
 * Throws `PlaceNameConflict` when the row is no longer resolvable, or when
 * the scope already has an alias for the spelling. Nothing is written then.
 */
export async function resolveIntoAlias(
  prisma: PrismaClient,
  args: ResolveIntoAliasArgs,
): Promise<{ aliasId: string; signalsMoved: number }> {
  const { row, locationId, userId, note } = args;
  const now = args.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    // Conditional on the status this request read, so a concurrent decision
    // wins once: another decider's answer is never overwritten, not even one
    // that left the row resolvable (ambiguous).
    const resolvable: readonly string[] = RESOLVABLE_STATUSES;
    if (!resolvable.includes(row.status)) throw new PlaceNameConflict("ROW_CLOSED");
    const { count } = await tx.unresolvedPlaceNames.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: "resolved", resolvedById: userId, resolvedAt: now, resolutionNote: note },
    });
    if (count === 0) throw new PlaceNameConflict("ROW_CLOSED");

    let aliasId = args.aliasId;
    if (!aliasId) {
      try {
        const alias = await tx.placeAliases.create({
          data: {
            nameNorm: row.nameNorm,
            nameDisplay: row.nameAsWritten,
            countryCode: row.countryCode,
            scopeLocationId: row.stateLocationId,
            locationId,
            source: args.source,
            createdById: userId,
            note,
          },
          select: { id: true },
        });
        aliasId = alias.id;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new PlaceNameConflict("ALIAS_EXISTS");
        }
        throw err;
      }
      // The Arabic spelling is the one the source writes; the Latin spelling
      // is a transliteration that varies from post to post. Alias both, so
      // the next post resolves whichever spelling the pipeline asks with.
      // An Arabic alias that exists already (another row's) is left alone.
      const arabicNorm = row.nameAr ? normalizeGazetteerName(row.nameAr) : "";
      if (row.nameAr && arabicNorm && arabicNorm !== row.nameNorm) {
        await tx.placeAliases.createMany({
          data: [
            {
              nameNorm: arabicNorm,
              nameDisplay: row.nameAr,
              countryCode: row.countryCode,
              scopeLocationId: row.stateLocationId,
              locationId,
              source: args.source,
              createdById: userId,
              note,
            },
          ],
          skipDuplicates: true,
        });
      }
    }
    await tx.unresolvedPlaceNames.update({ where: { id: row.id }, data: { placeAliasId: aliasId } });

    const signalsMoved = await moveWaitingSignals(tx, row.id, locationId, now);
    return { aliasId, signalsMoved };
  });
}

/**
 * A miss recorded on a row that is resolved already: apply the row's alias to
 * the Signals that wait on it, under the same rule as the resolution. This
 * closes a race: a pipeline run can miss the alias lookup just before the
 * resolution commits, and record its miss just after. Without this, that
 * Signal would wait on a closed row for good. Returns the number moved.
 */
export async function moveLateSignals(tx: Prisma.TransactionClient, unresolvedPlaceNameId: string): Promise<number> {
  const row = await tx.unresolvedPlaceNames.findUnique({
    where: { id: unresolvedPlaceNameId },
    select: { status: true, placeAlias: { select: { locationId: true } } },
  });
  if (row?.status !== "resolved" || !row.placeAlias) return 0;
  return moveWaitingSignals(tx, unresolvedPlaceNameId, row.placeAlias.locationId, new Date());
}

/**
 * Move the Signals that wait on a queue row to `locationId`, and stamp their
 * links. See `resolveIntoAlias` for the rule. Returns the number moved.
 */
export async function moveWaitingSignals(
  tx: Prisma.TransactionClient,
  unresolvedPlaceNameId: string,
  locationId: string,
  now: Date,
): Promise<number> {
  const moved = await tx.$queryRaw<{ id: string }[]>`
    WITH target AS (
      SELECT "ancestor_ids" FROM "locations" WHERE "id" = ${locationId}
    ),
    moved AS (
      UPDATE "signals" s
      SET "location_id" = ${locationId}
      FROM "unresolved_place_name_signals" k, target
      WHERE k."unresolved_place_name_id" = ${unresolvedPlaceNameId}
        AND k."signal_id" = s."id"
        AND k."relocated_at" IS NULL
        AND s."location_corrected_at" IS NULL
        AND s."location_id" IS NOT NULL
        AND s."location_id" = ANY(target."ancestor_ids")
      RETURNING s."id"
    )
    UPDATE "unresolved_place_name_signals" k
    SET "relocated_at" = ${now}
    FROM moved
    WHERE k."unresolved_place_name_id" = ${unresolvedPlaceNameId} AND k."signal_id" = moved."id"
    RETURNING k."signal_id" AS "id"`;
  return moved.length;
}
