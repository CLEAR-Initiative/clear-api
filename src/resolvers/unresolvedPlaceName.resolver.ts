import { randomUUID } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import { requireRole } from "../utils/auth-guard.js";
import { normalizeGazetteerName } from "../utils/geonames-normalize.js";
import { requirePlaceNameDecider } from "../utils/place-name-access.js";
import { canReadSignal } from "../utils/signal-access.js";

// ─── Unresolved place names (ADR-0019, Exponential #1307) ────────────────────
// The pipeline records each place name that geocoding could not place inside
// the Signal's area. A decider reads the queue. Resolving a row is a later
// slice (#1309): nothing here changes a row's status.

export const UNRESOLVED_PLACE_NAME_STATUSES = ["open", "resolved", "not_a_place", "ambiguous"] as const;
export type UnresolvedPlaceNameStatus = (typeof UNRESOLVED_PLACE_NAME_STATUSES)[number];
export const UNRESOLVED_PLACE_NAME_REASONS = ["no_match", "outside_area"] as const;
export type UnresolvedPlaceNameReason = (typeof UNRESOLVED_PLACE_NAME_REASONS)[number];

const NAME_MAX = 500;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const SIGNALS_DEFAULT = 5;
const SIGNALS_MAX = 50;

interface RecordInput {
  signalId: string;
  name: string;
  nameAr?: string | null;
  countryCode: string;
  areaLocationId: string;
  reason?: UnresolvedPlaceNameReason | null;
  seenAt?: Date | null;
}

interface QueueArgs {
  status?: UnresolvedPlaceNameStatus | null;
  countryCode?: string | null;
  areaLocationId?: string | null;
  first?: number | null;
  offset?: number | null;
}

/** A queue row as the raw queue query returns it (the Prisma model's shape). */
interface QueueRow {
  id: string;
  nameNorm: string;
  nameAsWritten: string;
  nameAr: string | null;
  countryCode: string;
  stateLocationId: string | null;
  status: string;
  signalCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedById: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  placeAliasId: string | null;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

function notFound(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "NOT_FOUND" } });
}

/** Trim to null (empty → null); reject when over `max`. */
function trimText(value: string | null | undefined, max: number, field: string): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw badInput(`${field} must be at most ${max} characters.`);
  return trimmed;
}

/** ISO-3166-1 alpha-2, upper case. */
export function normalizeCountryCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw badInput("countryCode must be a two-letter ISO country code.");
  return code;
}

/**
 * The state (level 1) that holds `areaLocationId`, and the country code of
 * its country (level 0) when that location carries one. The state is null
 * when the area is the country itself, or sits under no state.
 */
export async function stateOfArea(
  prisma: Context["prisma"],
  areaLocationId: string,
): Promise<{ stateLocationId: string | null; countryCode: string | null } | null> {
  const area = await prisma.locations.findUnique({
    where: { id: areaLocationId },
    select: { id: true, level: true, pCode: true, ancestorIds: true },
  });
  if (!area) return null;
  const ancestors =
    area.ancestorIds.length > 0
      ? await prisma.locations.findMany({
          where: { id: { in: area.ancestorIds }, level: { in: [0, 1] } },
          select: { id: true, level: true, pCode: true },
        })
      : [];
  const chain = [area, ...ancestors];
  const state = chain.find((l) => l.level === 1);
  const country = chain.find((l) => l.level === 0);
  return {
    stateLocationId: state?.id ?? null,
    countryCode: country?.pCode ? country.pCode.toUpperCase() : null,
  };
}

const QUEUE_COLUMNS = Prisma.sql`
  u."id", u."name_norm" AS "nameNorm", u."name_as_written" AS "nameAsWritten",
  u."name_ar" AS "nameAr", u."country_code" AS "countryCode",
  u."state_location_id" AS "stateLocationId", u."status",
  u."signal_count" AS "signalCount", u."first_seen_at" AS "firstSeenAt",
  u."last_seen_at" AS "lastSeenAt", u."resolved_by_id" AS "resolvedById",
  u."resolved_at" AS "resolvedAt", u."resolution_note" AS "resolutionNote",
  u."place_alias_id" AS "placeAliasId"`;

export const unresolvedPlaceNameResolvers = {
  // Stored lower case (DB CHECK); upper case on the API.
  UnresolvedPlaceNameStatus: {
    OPEN: "open",
    RESOLVED: "resolved",
    NOT_A_PLACE: "not_a_place",
    AMBIGUOUS: "ambiguous",
  },
  UnresolvedPlaceNameReason: {
    NO_MATCH: "no_match",
    OUTSIDE_AREA: "outside_area",
  },
  PlaceAliasSource: {
    REVIEW: "review",
    SEED: "seed",
    MANUAL: "manual",
  },

  Query: {
    unresolvedPlaceNames: async (_parent: unknown, args: QueueArgs, context: Context) => {
      const { scope } = await requirePlaceNameDecider(context);

      const first = args.first ?? PAGE_DEFAULT;
      if (!Number.isInteger(first) || first < 1 || first > PAGE_MAX) {
        throw badInput(`first must be between 1 and ${PAGE_MAX}.`);
      }
      const offset = args.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0) throw badInput("offset must be 0 or more.");

      const where: Prisma.Sql[] = [];
      if (args.status) where.push(Prisma.sql`u."status" = ${args.status}`);
      if (args.countryCode) {
        where.push(Prisma.sql`u."country_code" = ${normalizeCountryCode(args.countryCode)}`);
      }
      if (args.areaLocationId) {
        // A country keeps every row of the country. A state, or a place
        // under one, keeps the rows of that state.
        const area = await stateOfArea(context.prisma, args.areaLocationId);
        if (!area) throw badInput("areaLocationId is not a known location.");
        if (area.stateLocationId) {
          where.push(Prisma.sql`u."state_location_id" = ${area.stateLocationId}`);
        } else if (area.countryCode) {
          where.push(Prisma.sql`u."country_code" = ${area.countryCode}`);
        } else {
          where.push(Prisma.sql`FALSE`);
        }
      }
      if (scope.kind === "area") {
        // A row with a state is in the area when the state is. A row with no
        // state belongs to its country, so the team must cover the country.
        const states = [...scope.locationIds];
        const countries = [...scope.countryCodes];
        where.push(Prisma.sql`(
          (u."state_location_id" IS NOT NULL AND u."state_location_id" = ANY(${states}::text[]))
          OR (u."state_location_id" IS NULL AND u."country_code" = ANY(${countries}::text[]))
        )`);
      }
      const filter = where.length > 0 ? Prisma.sql`WHERE ${Prisma.join(where, " AND ")}` : Prisma.empty;

      const [items, counted] = await Promise.all([
        context.prisma.$queryRaw<QueueRow[]>`
          SELECT ${QUEUE_COLUMNS}
          FROM "unresolved_place_names" u
          ${filter}
          ORDER BY (u."status" = 'open') DESC, u."signal_count" DESC, u."last_seen_at" DESC, u."id" ASC
          LIMIT ${first} OFFSET ${offset}`,
        context.prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS "count" FROM "unresolved_place_names" u ${filter}`,
      ]);
      const totalCount = Number(counted[0]?.count ?? 0);
      return { items, totalCount, hasMore: offset + items.length < totalCount };
    },
  },

  Mutation: {
    recordUnresolvedPlaceName: async (
      _parent: unknown,
      { input }: { input: RecordInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);

      const name = trimText(input.name, NAME_MAX, "name");
      const nameNorm = name ? normalizeGazetteerName(name) : "";
      if (!name || !nameNorm) throw badInput("name has no letters or digits to match on.");
      const nameAr = trimText(input.nameAr, NAME_MAX, "nameAr");
      const countryCode = normalizeCountryCode(input.countryCode);
      const reason = input.reason ?? "no_match";
      const seenAt = input.seenAt ?? new Date();
      if (Number.isNaN(seenAt.getTime())) throw badInput("seenAt is not a valid date-time.");

      const signal = await context.prisma.signals.findUnique({
        where: { id: input.signalId },
        select: { id: true },
      });
      if (!signal) throw notFound(`Signal ${input.signalId} not found.`);
      const area = await stateOfArea(context.prisma, input.areaLocationId);
      if (!area) throw badInput("areaLocationId is not a known location.");
      if (area.countryCode && area.countryCode !== countryCode) {
        throw badInput(`areaLocationId is in ${area.countryCode}, not in ${countryCode}.`);
      }

      const id = await context.prisma.$transaction(async (tx) => {
        // Create the row, or lock the one that exists: the no-op update takes
        // its row lock, so two recorders of one spelling count one at a time.
        // The status never changes here. A closed row (not a place, resolved,
        // ambiguous) stays closed; only its count and dates move.
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "unresolved_place_names"
            ("id", "name_norm", "name_as_written", "name_ar", "country_code", "state_location_id",
             "status", "signal_count", "first_seen_at", "last_seen_at")
          VALUES (${randomUUID()}, ${nameNorm}, ${name}, ${nameAr}, ${countryCode}, ${area.stateLocationId},
                  'open', 0, ${seenAt}, ${seenAt})
          ON CONFLICT ("country_code", "name_norm", "state_location_id") DO UPDATE
            SET "name_ar" = COALESCE("unresolved_place_names"."name_ar", EXCLUDED."name_ar")
          RETURNING "id"`;
        const rowId = rows[0]!.id;
        // A Signal counts once per row: a re-run inserts nothing.
        const linked = await tx.$executeRaw`
          INSERT INTO "unresolved_place_name_signals"
            ("unresolved_place_name_id", "signal_id", "area_location_id", "name_as_written", "reason", "seen_at")
          VALUES (${rowId}, ${signal.id}, ${input.areaLocationId}, ${name}, ${reason}, ${seenAt})
          ON CONFLICT ("unresolved_place_name_id", "signal_id") DO NOTHING`;
        if (linked > 0) {
          await tx.$executeRaw`
            UPDATE "unresolved_place_names"
            SET "signal_count" = "signal_count" + 1,
                "first_seen_at" = LEAST("first_seen_at", ${seenAt}),
                "last_seen_at" = GREATEST("last_seen_at", ${seenAt}),
                "updated_at" = CURRENT_TIMESTAMP
            WHERE "id" = ${rowId}`;
        }
        return rowId;
      });

      return context.prisma.unresolvedPlaceNames.findUnique({ where: { id } });
    },
  },

  UnresolvedPlaceName: {
    stateLocation: (parent: { stateLocationId: string | null }, _args: unknown, { prisma }: Context) =>
      parent.stateLocationId ? prisma.locations.findUnique({ where: { id: parent.stateLocationId } }) : null,
    placeAlias: (parent: { placeAliasId: string | null }, _args: unknown, { prisma }: Context) =>
      parent.placeAliasId ? prisma.placeAliases.findUnique({ where: { id: parent.placeAliasId } }) : null,
    resolvedByName: async (parent: { resolvedById: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.resolvedById) return null;
      const u = await prisma.user.findUnique({ where: { id: parent.resolvedById }, select: { name: true } });
      return u?.name ?? null;
    },
    signals: (parent: { id: string }, args: { first?: number | null }, { prisma }: Context) => {
      const take = args.first ?? SIGNALS_DEFAULT;
      if (!Number.isInteger(take) || take < 1 || take > SIGNALS_MAX) {
        throw badInput(`first must be between 1 and ${SIGNALS_MAX}.`);
      }
      return prisma.unresolvedPlaceNameSignals.findMany({
        where: { unresolvedPlaceNameId: parent.id },
        orderBy: [{ seenAt: "desc" }, { signalId: "asc" }],
        take,
      });
    },
  },

  UnresolvedPlaceNameSignal: {
    // Null when the caller may not read the Signal (an API-only user's
    // source grants): the link still lists, without the Signal's content.
    signal: async (parent: { signalId: string }, _args: unknown, { prisma, signalScope }: Context) => {
      const signal = await prisma.signals.findUnique({ where: { id: parent.signalId } });
      return canReadSignal(signalScope, signal) ? signal : null;
    },
    areaLocation: (parent: { areaLocationId: string | null }, _args: unknown, { prisma }: Context) =>
      parent.areaLocationId ? prisma.locations.findUnique({ where: { id: parent.areaLocationId } }) : null,
  },

  PlaceAlias: {
    location: (parent: { locationId: string }, _args: unknown, { prisma }: Context) =>
      prisma.locations.findUnique({ where: { id: parent.locationId } }),
    scopeLocation: (parent: { scopeLocationId: string | null }, _args: unknown, { prisma }: Context) =>
      parent.scopeLocationId ? prisma.locations.findUnique({ where: { id: parent.scopeLocationId } }) : null,
    createdByName: async (parent: { createdById: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.createdById) return null;
      const u = await prisma.user.findUnique({ where: { id: parent.createdById }, select: { name: true } });
      return u?.name ?? null;
    },
  },
};
