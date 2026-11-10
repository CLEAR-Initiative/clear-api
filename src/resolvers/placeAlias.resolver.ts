import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import { isPlatformAdmin } from "../utils/auth-guard.js";
import { logActivity } from "../utils/activity-log.js";
import { findOrCreateLandmarkL4, resolveContainingAdminArea } from "../utils/geo-resolve.js";
import { normalizeGazetteerName } from "../utils/geonames-normalize.js";
import { canWritePlaceAlias, requirePlaceNameDecider, type PlaceNameScope } from "../utils/place-name-access.js";
import { PlaceNameConflict, RESOLVABLE_STATUSES, resolveIntoAlias } from "../services/place-names.js";
import {
  NAME_MAX,
  NOTE_MAX,
  assertPoint,
  badInput,
  chainOf,
  conflict,
  forbidden,
  normalizeCountryCode,
  notFound,
  stateOfArea,
  trimText,
} from "./unresolvedPlaceName.resolver.js";

// ─── Place aliases (ADR-0019, Exponential #1310) ─────────────────────────────
// The alias list is the synonym list CLEAR builds up: the spellings it maps
// to its own locations. A decider lists it, adds to it by hand, corrects it
// and deletes from it, with no queue row needed.

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const SOURCES: readonly string[] = ["review", "seed", "manual"];

interface PointInput {
  lat: number;
  lng: number;
  name?: string | null;
}

interface CreateInput {
  name: string;
  nameAr?: string | null;
  countryCode: string;
  scopeLocationId?: string | null;
  locationId?: string | null;
  point?: PointInput | null;
  note?: string | null;
}

interface UpdateInput {
  locationId?: string | null;
  point?: PointInput | null;
  scopeLocationId?: string | null;
  note?: string | null;
}

interface ListArgs {
  countryCode?: string | null;
  search?: string | null;
  scopeLocationId?: string | null;
  source?: string | null;
  first?: number | null;
  after?: string | null;
}

type User = NonNullable<Context["user"]>;

function aliasForbidden(): GraphQLError {
  return forbidden(
    "You can change aliases scoped inside your team's area; a platform admin changes the others, and country-wide ones",
  );
}

function aliasExists(): GraphQLError {
  return conflict("This spelling already has a place alias in this scope");
}

/**
 * A scope for an alias: a state (level 1) in the alias's country, or null
 * for the whole country. Returns the country location that holds it.
 */
async function checkScope(
  context: Context,
  scopeLocationId: string | null,
  countryCode: string,
): Promise<{ countryLocationId: string | null }> {
  if (!scopeLocationId) return { countryLocationId: null };
  const scope = await context.prisma.locations.findUnique({
    where: { id: scopeLocationId },
    select: { level: true },
  });
  if (!scope) throw badInput("scopeLocationId is not a known location.");
  if (scope.level !== 1) throw badInput("The scope of an alias is a state, or the whole country.");
  const area = await stateOfArea(context.prisma, scopeLocationId);
  if (area?.countryCode && area.countryCode !== countryCode) {
    throw badInput(`scopeLocationId is in ${area.countryCode}, not in ${countryCode}.`);
  }
  return { countryLocationId: area?.countryLocationId ?? null };
}

/**
 * The CLEAR location an alias points at, from `locationId` or from `point`
 * (which becomes a level-4 landmark). The target must be in the alias's
 * country. A team admin must put it inside the alias's scope; a platform
 * admin may put it anywhere in the country.
 */
async function targetLocation(
  context: Context,
  user: User,
  target: { locationId?: string | null; point?: PointInput | null },
  alias: { scopeLocationId: string | null; countryLocationId: string | null; countryCode: string; name: string },
): Promise<string> {
  const hasLocation = target.locationId != null;
  const hasPoint = target.point != null;
  if (hasLocation === hasPoint) throw badInput("Give the target as locationId or as point, not both.");

  const assertPlace = async (chain: string[]) => {
    if (alias.countryLocationId) {
      if (!chain.includes(alias.countryLocationId)) throw badInput("The target is outside the country of this alias.");
    } else {
      // A country-wide alias: the country is known by its code only.
      const root = chain[chain.length - 1];
      const country = root ? await stateOfArea(context.prisma, root) : null;
      if (country?.countryCode && country.countryCode !== alias.countryCode) {
        throw badInput("The target is outside the country of this alias.");
      }
    }
    if (!isPlatformAdmin(user) && !(alias.scopeLocationId && chain.includes(alias.scopeLocationId))) {
      throw forbidden("The target is outside the state of this alias; a platform admin can put it there");
    }
  };

  if (hasLocation) {
    const location = await context.prisma.locations.findUnique({
      where: { id: target.locationId! },
      select: { id: true, level: true, ancestorIds: true },
    });
    if (!location) throw badInput("locationId is not a known location.");
    if (location.level < 1) throw badInput("A country cannot be the target: pick a place inside it.");
    await assertPlace([location.id, ...location.ancestorIds]);
    return location.id;
  }

  const point = target.point!;
  assertPoint(point.lat, point.lng);
  const name = trimText(point.name, NAME_MAX, "point.name") ?? alias.name;
  const placement = await resolveContainingAdminArea(context.prisma, point.lat, point.lng);
  const chain = placement ? await chainOf(context.prisma, placement.id) : null;
  if (!placement || !chain) throw badInput("The place is outside the areas CLEAR covers.");
  await assertPlace(chain);
  const insideScope = alias.scopeLocationId != null && chain.includes(alias.scopeLocationId);
  const found = await findOrCreateLandmarkL4(context.prisma, {
    name,
    lat: point.lat,
    lng: point.lng,
    kind: "admin",
    withinId: insideScope ? alias.scopeLocationId : placement.id,
  });
  if (!found.locationId) {
    throw new GraphQLError("The place could not be placed", { extensions: { code: "INTERNAL_SERVER_ERROR" } });
  }
  return found.locationId;
}

function isUniqueClash(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Whether each alias of a page may be changed by this caller. */
function withCanEdit<T extends { scopeLocationId: string | null }>(
  rows: T[],
  user: User,
  scope: PlaceNameScope,
): Array<T & { canEdit: boolean }> {
  return rows.map((row) => ({ ...row, canEdit: canWritePlaceAlias(user, scope, row.scopeLocationId) }));
}

export const placeAliasResolvers = {
  Query: {
    placeAliases: async (_parent: unknown, args: ListArgs, context: Context) => {
      const { user, scope } = await requirePlaceNameDecider(context);

      const first = args.first ?? PAGE_DEFAULT;
      if (!Number.isInteger(first) || first < 1 || first > PAGE_MAX) {
        throw badInput(`first must be between 1 and ${PAGE_MAX}.`);
      }
      if (args.source && !SOURCES.includes(args.source)) {
        throw badInput(`source must be one of: ${SOURCES.join(", ")}.`);
      }

      const where: Prisma.placeAliasesWhereInput = {};
      if (args.countryCode) where.countryCode = normalizeCountryCode(args.countryCode);
      if (args.scopeLocationId) where.scopeLocationId = args.scopeLocationId;
      if (args.source) where.source = args.source;
      const search = trimText(args.search, NAME_MAX, "search");
      if (search) {
        const norm = normalizeGazetteerName(search);
        where.OR = [
          ...(norm ? [{ nameNorm: { contains: norm } }] : []),
          { nameDisplay: { contains: search, mode: "insensitive" } },
          { location: { name: { contains: search, mode: "insensitive" } } },
        ];
      }

      // Newest first; the id breaks ties, so the cursor is stable.
      if (args.after) {
        const cursor = await context.prisma.placeAliases.findUnique({
          where: { id: args.after },
          select: { id: true },
        });
        if (!cursor) throw badInput("after is not a known alias: read the list again from the start.");
      }
      const [rows, totalCount] = await Promise.all([
        context.prisma.placeAliases.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: first + 1,
          ...(args.after ? { cursor: { id: args.after }, skip: 1 } : {}),
        }),
        context.prisma.placeAliases.count({ where }),
      ]);
      const hasMore = rows.length > first;
      const items = withCanEdit(hasMore ? rows.slice(0, first) : rows, user, scope);
      return { items, totalCount, hasMore, endCursor: hasMore ? items[items.length - 1]!.id : null };
    },
  },

  Mutation: {
    createPlaceAlias: async (_parent: unknown, { input }: { input: CreateInput }, context: Context) => {
      const { user, scope } = await requirePlaceNameDecider(context);

      const name = trimText(input.name, NAME_MAX, "name");
      const nameNorm = name ? normalizeGazetteerName(name) : "";
      if (!name || !nameNorm) throw badInput("name has no letters or digits to match on.");
      const nameAr = trimText(input.nameAr, NAME_MAX, "nameAr");
      const arabicNorm = nameAr ? normalizeGazetteerName(nameAr) : "";
      const note = trimText(input.note, NOTE_MAX, "note");
      const countryCode = normalizeCountryCode(input.countryCode);
      const scopeLocationId = input.scopeLocationId ?? null;

      if (!canWritePlaceAlias(user, scope, scopeLocationId)) throw aliasForbidden();
      const { countryLocationId } = await checkScope(context, scopeLocationId, countryCode);
      const locationId = await targetLocation(
        context,
        user,
        { locationId: input.locationId, point: input.point },
        { scopeLocationId, countryLocationId, countryCode, name },
      );

      const base = { countryCode, scopeLocationId, locationId, source: "manual", createdById: user.id, note };
      let alias;
      try {
        alias = await context.prisma.$transaction(async (tx) => {
          const created = await tx.placeAliases.create({ data: { ...base, nameNorm, nameDisplay: name } });
          // The Arabic spelling gets its own alias, as a resolution gives it.
          // One that exists already (another answer's) is left alone.
          if (nameAr && arabicNorm && arabicNorm !== nameNorm) {
            await tx.placeAliases.createMany({
              data: [{ ...base, nameNorm: arabicNorm, nameDisplay: nameAr }],
              skipDuplicates: true,
            });
          }
          return created;
        });
      } catch (err) {
        if (isUniqueClash(err)) throw aliasExists();
        throw err;
      }

      // The alias answers the open queue rows with this spelling: in its
      // state, or in every state for a country-wide alias. Each row closes
      // and its waiting Signals move, as a resolution does. A row another
      // decider closed meanwhile stays as they left it.
      const rows = await context.prisma.unresolvedPlaceNames.findMany({
        where: {
          countryCode,
          nameNorm: { in: [nameNorm, ...(arabicNorm ? [arabicNorm] : [])] },
          status: { in: [...RESOLVABLE_STATUSES] },
          ...(scopeLocationId ? { stateLocationId: scopeLocationId } : {}),
        },
      });
      let rowsResolved = 0;
      let signalsMoved = 0;
      for (const row of rows) {
        try {
          const result = await resolveIntoAlias(context.prisma, {
            row,
            locationId,
            userId: user.id,
            note,
            source: "manual",
            aliasId: alias.id,
          });
          rowsResolved += 1;
          signalsMoved += result.signalsMoved;
        } catch (err) {
          if (!(err instanceof PlaceNameConflict)) throw err;
        }
      }

      void logActivity(context.prisma, {
        userId: user.id,
        action: "place_alias.create",
        resourceType: "place_alias",
        resourceId: alias.id,
        metadata: { nameNorm, countryCode, scopeLocationId, locationId, rowsResolved, signalsMoved },
      });
      return { ...alias, canEdit: true };
    },

    updatePlaceAlias: async (
      _parent: unknown,
      { id, input }: { id: string; input: UpdateInput },
      context: Context,
    ) => {
      const { user, scope } = await requirePlaceNameDecider(context);
      const alias = await context.prisma.placeAliases.findUnique({ where: { id } });
      if (!alias) throw notFound("Place alias not found.");
      if (!canWritePlaceAlias(user, scope, alias.scopeLocationId)) throw aliasForbidden();

      // A field left out stays as it is; a null scope means the whole country.
      const scopeChanged = "scopeLocationId" in input;
      const scopeLocationId = scopeChanged ? (input.scopeLocationId ?? null) : alias.scopeLocationId;
      if (scopeChanged && !canWritePlaceAlias(user, scope, scopeLocationId)) throw aliasForbidden();
      const targetChanged = input.locationId != null || input.point != null;
      const noteChanged = "note" in input;
      if (!scopeChanged && !targetChanged && !noteChanged) throw badInput("Nothing to change.");

      // The target is checked against the scope the alias will have: a new
      // target, and also an old target under a new scope. A note alone
      // changes neither, so it needs no check.
      let locationId = alias.locationId;
      if (targetChanged || scopeChanged) {
        const { countryLocationId } = await checkScope(context, scopeLocationId, alias.countryCode);
        locationId = await targetLocation(
          context,
          user,
          targetChanged ? { locationId: input.locationId, point: input.point } : { locationId: alias.locationId },
          { scopeLocationId, countryLocationId, countryCode: alias.countryCode, name: alias.nameDisplay },
        );
      }

      let updated;
      try {
        updated = await context.prisma.placeAliases.update({
          where: { id },
          data: {
            scopeLocationId,
            locationId,
            ...(noteChanged ? { note: trimText(input.note, NOTE_MAX, "note") } : {}),
          },
        });
      } catch (err) {
        if (isUniqueClash(err)) throw aliasExists();
        throw err;
      }
      void logActivity(context.prisma, {
        userId: user.id,
        action: "place_alias.update",
        resourceType: "place_alias",
        resourceId: id,
        metadata: {
          nameNorm: alias.nameNorm,
          countryCode: alias.countryCode,
          previous: { scopeLocationId: alias.scopeLocationId, locationId: alias.locationId, note: alias.note },
          scopeLocationId,
          locationId,
        },
      });
      return { ...updated, canEdit: true };
    },

    deletePlaceAlias: async (_parent: unknown, { id }: { id: string }, context: Context) => {
      const { user, scope } = await requirePlaceNameDecider(context);
      const alias = await context.prisma.placeAliases.findUnique({ where: { id } });
      if (!alias) throw notFound("Place alias not found.");
      if (!canWritePlaceAlias(user, scope, alias.scopeLocationId)) throw aliasForbidden();

      // The queue rows this alias answered go back to open, so the name can
      // be answered again. Signals it moved stay where they are: deleting an
      // alias affects new Signals only.
      const reopened = await context.prisma.$transaction(async (tx) => {
        const { count } = await tx.unresolvedPlaceNames.updateMany({
          where: { placeAliasId: id, status: "resolved" },
          data: { status: "open", resolvedById: null, resolvedAt: null, resolutionNote: null, placeAliasId: null },
        });
        await tx.placeAliases.delete({ where: { id } });
        return count;
      });
      void logActivity(context.prisma, {
        userId: user.id,
        action: "place_alias.delete",
        resourceType: "place_alias",
        resourceId: id,
        metadata: {
          nameNorm: alias.nameNorm,
          nameDisplay: alias.nameDisplay,
          countryCode: alias.countryCode,
          scopeLocationId: alias.scopeLocationId,
          locationId: alias.locationId,
          source: alias.source,
          rowsReopened: reopened,
        },
      });
      return true;
    },
  },
};
