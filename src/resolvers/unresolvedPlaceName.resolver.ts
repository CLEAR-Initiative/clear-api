import { randomUUID } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import { isPlatformAdmin, requireRole } from "../utils/auth-guard.js";
import { logActivity } from "../utils/activity-log.js";
import { findOrCreateLandmarkL4, resolveContainingAdminArea } from "../utils/geo-resolve.js";
import { normalizeGazetteerName } from "../utils/geonames-normalize.js";
import { canWritePlaceAlias, placeNameInScope, requirePlaceNameDecider } from "../utils/place-name-access.js";
import { canReadSignal } from "../utils/signal-access.js";
import {
  PlaceNameConflict,
  RESOLVABLE_STATUSES,
  moveLateSignals,
  resolveIntoAlias,
  suggestPlaces,
} from "../services/place-names.js";

// ─── Unresolved place names (ADR-0019, Exponential #1307, #1309) ─────────────
// The pipeline records each place name that geocoding could not place inside
// the Signal's area. A decider reads the queue and resolves a row: the answer
// becomes a place alias, and the waiting Signals move.

export const UNRESOLVED_PLACE_NAME_STATUSES = ["open", "resolved", "not_a_place", "ambiguous"] as const;
export type UnresolvedPlaceNameStatus = (typeof UNRESOLVED_PLACE_NAME_STATUSES)[number];
export const UNRESOLVED_PLACE_NAME_REASONS = ["no_match", "outside_area"] as const;
export type UnresolvedPlaceNameReason = (typeof UNRESOLVED_PLACE_NAME_REASONS)[number];

export const NAME_MAX = 500;
export const NOTE_MAX = 2000;
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

type ResolutionKind = "LOCATION" | "GEONAMES" | "POINT" | "NOT_A_PLACE" | "AMBIGUOUS";

interface ResolutionInput {
  kind: ResolutionKind;
  locationId?: string | null;
  geonamesId?: number | null;
  point?: { lat: number; lng: number; name?: string | null } | null;
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
  countryLocationId: string | null;
  status: string;
  signalCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedById: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  placeAliasId: string | null;
}

export function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

export function notFound(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "NOT_FOUND" } });
}

export function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "FORBIDDEN" } });
}

export function conflict(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "CONFLICT" } });
}

export function assertPoint(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw badInput("The point's latitude must be a finite number in [-90, 90].");
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw badInput("The point's longitude must be a finite number in [-180, 180].");
  }
}

/** Each kind takes exactly its own field. */
function assertResolutionShape(r: ResolutionInput): void {
  const given = {
    locationId: r.locationId != null,
    geonamesId: r.geonamesId != null,
    point: r.point != null,
  };
  const needs: Record<ResolutionKind, keyof typeof given | null> = {
    LOCATION: "locationId",
    GEONAMES: "geonamesId",
    POINT: "point",
    NOT_A_PLACE: null,
    AMBIGUOUS: null,
  };
  const need = needs[r.kind];
  for (const field of Object.keys(given) as Array<keyof typeof given>) {
    if (field === need && !given[field]) throw badInput(`${r.kind} needs ${field}.`);
    if (field !== need && given[field]) throw badInput(`${r.kind} does not take ${field}.`);
  }
}

/** A location with its ancestors: the chain a place must be inside. */
export async function chainOf(prisma: Context["prisma"], locationId: string): Promise<string[] | null> {
  const loc = await prisma.locations.findUnique({
    where: { id: locationId },
    select: { id: true, ancestorIds: true },
  });
  return loc ? [loc.id, ...loc.ancestorIds] : null;
}

/** Trim to null (empty → null); reject when over `max`. */
export function trimText(value: string | null | undefined, max: number, field: string): string | null {
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
 * The state (level 1) and the country (level 0) that hold `areaLocationId`,
 * and the country's ISO code when its location carries one (`pCode`; a
 * country made by `ensureCountryLocation` has none). The state is null when
 * the area is the country itself, or sits under no state.
 */
export async function stateOfArea(
  prisma: Context["prisma"],
  areaLocationId: string,
): Promise<{
  stateLocationId: string | null;
  countryLocationId: string | null;
  countryCode: string | null;
} | null> {
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
    countryLocationId: country?.id ?? null,
    countryCode: country?.pCode ? country.pCode.toUpperCase() : null,
  };
}

const QUEUE_COLUMNS = Prisma.sql`
  u."id", u."name_norm" AS "nameNorm", u."name_as_written" AS "nameAsWritten",
  u."name_ar" AS "nameAr", u."country_code" AS "countryCode",
  u."state_location_id" AS "stateLocationId",
  u."country_location_id" AS "countryLocationId", u."status",
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
        } else if (area.countryLocationId) {
          where.push(Prisma.sql`u."country_location_id" = ${area.countryLocationId}`);
        } else {
          where.push(Prisma.sql`FALSE`);
        }
      }
      if (scope.kind === "area") {
        // A row with a state is in the area when the state is. A row with no
        // state belongs to its country, so the team must cover the country.
        const ids = [...scope.locationIds];
        where.push(
          Prisma.sql`COALESCE(u."state_location_id", u."country_location_id") = ANY(${ids}::text[])`,
        );
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

    placeNameSuggestions: async (
      _parent: unknown,
      args: { name: string; nameAr?: string | null; countryCode: string; withinLocationId?: string | null },
      context: Context,
    ) => {
      await requirePlaceNameDecider(context);
      const name = trimText(args.name, NAME_MAX, "name");
      if (!name) throw badInput("name is required.");
      const nameAr = trimText(args.nameAr, NAME_MAX, "nameAr");
      const countryCode = normalizeCountryCode(args.countryCode);

      // CLEAR locations are searched inside the country's location. With an
      // area, that is the area's country; without one, the country that
      // carries the code (none carries it: no CLEAR locations are suggested).
      let countryLocationId: string | null;
      if (args.withinLocationId) {
        const area = await stateOfArea(context.prisma, args.withinLocationId);
        if (!area) throw badInput("withinLocationId is not a known location.");
        // One country for both lists: GeoNames is searched by code, CLEAR
        // locations by the area's country.
        if (area.countryCode && area.countryCode !== countryCode) {
          throw badInput(`withinLocationId is in ${area.countryCode}, not in ${countryCode}.`);
        }
        countryLocationId = area.countryLocationId;
      } else {
        const country = await context.prisma.locations.findFirst({
          where: { level: 0, pCode: { equals: countryCode, mode: "insensitive" } },
          select: { id: true },
        });
        countryLocationId = country?.id ?? null;
      }
      return suggestPlaces(context.prisma, {
        name,
        nameAr,
        countryCode,
        countryLocationId,
        withinLocationId: args.withinLocationId ?? null,
      });
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
             "country_location_id", "status", "signal_count", "first_seen_at", "last_seen_at")
          VALUES (${randomUUID()}, ${nameNorm}, ${name}, ${nameAr}, ${countryCode}, ${area.stateLocationId},
                  ${area.countryLocationId}, 'open', 0, ${seenAt}, ${seenAt})
          ON CONFLICT ("country_code", "name_norm", "state_location_id") DO UPDATE
            SET "name_ar" = COALESCE("unresolved_place_names"."name_ar", EXCLUDED."name_ar"),
                "country_location_id" =
                  COALESCE("unresolved_place_names"."country_location_id", EXCLUDED."country_location_id")
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
        // The row may be resolved already (this miss lost a race with the
        // resolution): its alias then applies to this Signal at once.
        await moveLateSignals(tx, rowId);
        return rowId;
      });

      return context.prisma.unresolvedPlaceNames.findUnique({ where: { id } });
    },

    resolveUnresolvedPlaceName: async (
      _parent: unknown,
      args: { id: string; resolution: ResolutionInput; note?: string | null },
      context: Context,
    ) => {
      const { user, scope } = await requirePlaceNameDecider(context);
      const row = await context.prisma.unresolvedPlaceNames.findUnique({ where: { id: args.id } });
      if (!row) throw notFound("Unresolved place name not found.");
      if (!placeNameInScope(scope, row)) throw forbidden("This place name is outside your team's area");

      const resolvable: readonly string[] = RESOLVABLE_STATUSES;
      const closed = () => conflict(`This place name is already ${row.status.replaceAll("_", " ")}`);
      if (!resolvable.includes(row.status)) throw closed();
      const resolution = args.resolution;
      assertResolutionShape(resolution);
      const note = trimText(args.note, NOTE_MAX, "note");
      const { kind } = resolution;

      if (kind === "NOT_A_PLACE" || kind === "AMBIGUOUS") {
        const status = kind === "NOT_A_PLACE" ? "not_a_place" : "ambiguous";
        if (row.status === status) throw closed();
        // Conditional on the status read above, so a concurrent decision wins
        // once: another decider's answer is never overwritten.
        const { count } = await context.prisma.unresolvedPlaceNames.updateMany({
          where: { id: row.id, status: row.status },
          data: { status, resolvedById: user.id, resolvedAt: new Date(), resolutionNote: note },
        });
        if (count === 0) throw conflict("This place name was resolved in the meantime");
        void logActivity(context.prisma, {
          userId: user.id,
          action: kind === "NOT_A_PLACE" ? "place_name.not_a_place" : "place_name.ambiguous",
          resourceType: "place_name",
          resourceId: row.id,
          metadata: { nameNorm: row.nameNorm, countryCode: row.countryCode, stateLocationId: row.stateLocationId },
        });
        return context.prisma.unresolvedPlaceNames.findUnique({ where: { id: row.id } });
      }

      // A location answer. The place must be in the row's country. A team
      // admin must place it inside the row's state (the country, for a row
      // with no state); a platform admin may place it anywhere in the country.
      const anywhereInCountry = isPlatformAdmin(user);
      const home = row.stateLocationId ?? row.countryLocationId;
      const assertPlace = (chain: string[]) => {
        if (row.countryLocationId && !chain.includes(row.countryLocationId)) {
          throw badInput("The place is outside the country of this place name.");
        }
        if (!anywhereInCountry && !(home && chain.includes(home))) {
          throw forbidden(
            "The place is outside the state of this place name; a platform admin can place it there",
          );
        }
      };

      let locationId: string;
      if (kind === "LOCATION") {
        const target = await context.prisma.locations.findUnique({
          where: { id: resolution.locationId! },
          select: { id: true, level: true, ancestorIds: true },
        });
        if (!target) throw badInput("locationId is not a known location.");
        if (target.level < 1) throw badInput("A country cannot be the answer: pick a place inside it.");
        assertPlace([target.id, ...target.ancestorIds]);
        locationId = target.id;
      } else {
        let place: { lat: number; lng: number; name: string };
        if (kind === "GEONAMES") {
          const hit = await context.prisma.geonames.findUnique({ where: { geonamesId: resolution.geonamesId! } });
          if (!hit) throw badInput("geonamesId is not in the gazetteer.");
          if (hit.countryCode.toUpperCase() !== row.countryCode) {
            throw badInput("The place is outside the country of this place name.");
          }
          place = { lat: hit.latitude, lng: hit.longitude, name: hit.name };
        } else {
          const point = resolution.point!;
          assertPoint(point.lat, point.lng);
          place = {
            lat: point.lat,
            lng: point.lng,
            name: trimText(point.name, NAME_MAX, "point.name") ?? row.nameAsWritten,
          };
        }
        // Inside an admin area, not near one: a place just across a border
        // is not its neighbour's.
        const placement = await resolveContainingAdminArea(context.prisma, place.lat, place.lng);
        const chain = placement ? await chainOf(context.prisma, placement.id) : null;
        if (!placement || !chain) throw badInput("The place is outside the areas CLEAR covers.");
        assertPlace(chain);
        // Reuse a same-name point under the row's state; for a place a
        // platform admin put outside it, under the area that holds the point.
        const insideState = row.stateLocationId != null && chain.includes(row.stateLocationId);
        const found = await findOrCreateLandmarkL4(context.prisma, {
          name: place.name,
          lat: place.lat,
          lng: place.lng,
          kind: "admin",
          withinId: insideState ? row.stateLocationId : placement.id,
        });
        if (!found.locationId) {
          throw new GraphQLError("The place could not be placed", {
            extensions: { code: "INTERNAL_SERVER_ERROR" },
          });
        }
        locationId = found.locationId;
      }

      let result: { aliasId: string; signalsMoved: number };
      try {
        result = await resolveIntoAlias(context.prisma, {
          row,
          locationId,
          userId: user.id,
          note,
          source: "review",
        });
      } catch (err) {
        if (err instanceof PlaceNameConflict) {
          throw conflict(
            err.reason === "ALIAS_EXISTS"
              ? "This spelling already has a place alias in this state"
              : "This place name was resolved in the meantime",
          );
        }
        throw err;
      }
      void logActivity(context.prisma, {
        userId: user.id,
        action: "place_name.resolve",
        resourceType: "place_name",
        resourceId: row.id,
        metadata: {
          kind,
          nameNorm: row.nameNorm,
          countryCode: row.countryCode,
          stateLocationId: row.stateLocationId,
          locationId,
          placeAliasId: result.aliasId,
          signalsMoved: result.signalsMoved,
        },
      });
      return context.prisma.unresolvedPlaceNames.findUnique({ where: { id: row.id } });
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
    signalsMoved: (parent: { id: string }, _args: unknown, { prisma }: Context) =>
      prisma.unresolvedPlaceNameSignals.count({
        where: { unresolvedPlaceNameId: parent.id, relocatedAt: { not: null } },
      }),
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
    // The alias list sets it for the whole page. Reached another way (a
    // queue row's alias), it is worked out for this caller.
    canEdit: async (
      parent: { scopeLocationId: string | null; canEdit?: boolean },
      _args: unknown,
      context: Context,
    ) => {
      if (parent.canEdit !== undefined) return parent.canEdit;
      try {
        const { user, scope } = await requirePlaceNameDecider(context);
        return canWritePlaceAlias(user, scope, parent.scopeLocationId);
      } catch {
        return false;
      }
    },
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
