import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import { isPlatformAdmin } from "../utils/auth-guard.js";
import { logActivity } from "../utils/activity-log.js";
import { findOrCreateLandmarkL4, resolveContainingAdminArea } from "../utils/geo-resolve.js";
import { normalizeGazetteerName } from "../utils/geonames-normalize.js";
import { canWritePlaceAlias, requirePlaceNameDecider, type PlaceNameScope } from "../utils/place-name-access.js";
import {
  PlaceNameConflict,
  RESOLVABLE_STATUSES,
  countryLocationIdForCode,
  resolveIntoAliasTx,
} from "../services/place-names.js";
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

function changedMeanwhile(): GraphQLError {
  return conflict("This alias was changed or deleted in the meantime; read it again");
}

/**
 * The level-0 location of an alias's country. An alias is checked against
 * it, so it is required: a country CLEAR has no location for cannot have
 * aliases, because nothing could show that a target or a scope is inside it.
 */
async function countryOf(context: Context, countryCode: string): Promise<string> {
  const id = await countryLocationIdForCode(context.prisma, countryCode);
  if (!id) throw badInput(`CLEAR has no country location for ${countryCode}.`);
  return id;
}

/**
 * A scope for an alias: a state (level 1) of the alias's country, or null
 * for the whole country.
 */
async function checkScope(context: Context, scopeLocationId: string | null, countryLocationId: string): Promise<void> {
  if (!scopeLocationId) return;
  const scope = await context.prisma.locations.findUnique({
    where: { id: scopeLocationId },
    select: { level: true, ancestorIds: true },
  });
  if (!scope) throw badInput("scopeLocationId is not a known location.");
  if (scope.level !== 1) throw badInput("The scope of an alias is a state, or the whole country.");
  if (!scope.ancestorIds.includes(countryLocationId)) throw badInput("The scope is outside the country of this alias.");
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
  alias: { scopeLocationId: string | null; countryLocationId: string; name: string },
): Promise<string> {
  const hasLocation = target.locationId != null;
  const hasPoint = target.point != null;
  if (hasLocation === hasPoint) throw badInput("Give the target as locationId or as point, not both.");

  const assertPlace = (chain: string[]) => {
    if (!chain.includes(alias.countryLocationId)) throw badInput("The target is outside the country of this alias.");
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
    assertPlace([location.id, ...location.ancestorIds]);
    return location.id;
  }

  const point = target.point!;
  assertPoint(point.lat, point.lng);
  const name = trimText(point.name, NAME_MAX, "point.name") ?? alias.name;
  const placement = await resolveContainingAdminArea(context.prisma, point.lat, point.lng);
  const chain = placement ? await chainOf(context.prisma, placement.id) : null;
  if (!placement || !chain) throw badInput("The place is outside the areas CLEAR covers.");
  assertPlace(chain);
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
      const countryLocationId = await countryOf(context, countryCode);
      await checkScope(context, scopeLocationId, countryLocationId);
      const locationId = await targetLocation(
        context,
        user,
        { locationId: input.locationId, point: input.point },
        { scopeLocationId, countryLocationId, name },
      );

      // ONE transaction: the alias, its Arabic twin and the queue rows they
      // answer. A failure part-way leaves nothing behind, so the same request
      // can be sent again (an alias saved alone would answer CONFLICT, and its
      // rows could no longer be resolved from the queue).
      const base = { countryCode, scopeLocationId, locationId, source: "manual", createdById: user.id, note };
      let created: { alias: { id: string; scopeLocationId: string | null }; rowsResolved: number; signalsMoved: number };
      try {
        created = await context.prisma.$transaction(
          async (tx) => {
            const alias = await tx.placeAliases.create({ data: { ...base, nameNorm, nameDisplay: name } });
            // The Arabic spelling gets its own alias, as a resolution gives
            // it. One that exists already (another answer's) is left alone,
            // and stays the answer for the Arabic spelling.
            const spellings = new Map([[nameNorm, { id: alias.id, locationId }]]);
            if (nameAr && arabicNorm && arabicNorm !== nameNorm) {
              await tx.placeAliases.createMany({
                data: [{ ...base, nameNorm: arabicNorm, nameDisplay: nameAr }],
                skipDuplicates: true,
              });
              const arabic = await tx.placeAliases.findFirst({
                where: { countryCode, nameNorm: arabicNorm, scopeLocationId },
                select: { id: true, locationId: true },
              });
              if (arabic) spellings.set(arabicNorm, arabic);
            }

            // The open queue rows these spellings name: in the alias's state,
            // or in every state for a country-wide alias. Each row closes
            // under the alias of ITS spelling, with that alias's target, and
            // its waiting Signals move, as a resolution does. A row another
            // decider closed meanwhile stays as they left it.
            const rows = await tx.unresolvedPlaceNames.findMany({
              where: {
                countryCode,
                nameNorm: { in: [...spellings.keys()] },
                status: { in: [...RESOLVABLE_STATUSES] },
                ...(scopeLocationId ? { stateLocationId: scopeLocationId } : {}),
              },
            });
            let rowsResolved = 0;
            let signalsMoved = 0;
            for (const row of rows) {
              const answer = spellings.get(row.nameNorm)!;
              try {
                const result = await resolveIntoAliasTx(tx, {
                  row,
                  locationId: answer.locationId,
                  userId: user.id,
                  note,
                  source: "manual",
                  aliasId: answer.id,
                });
                rowsResolved += 1;
                signalsMoved += result.signalsMoved;
              } catch (err) {
                if (!(err instanceof PlaceNameConflict)) throw err;
              }
            }
            return { alias, rowsResolved, signalsMoved };
          },
          { timeout: 20_000 },
        );
      } catch (err) {
        if (isUniqueClash(err)) throw aliasExists();
        throw err;
      }
      const { alias, rowsResolved, signalsMoved } = created;

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
        const countryLocationId = await countryOf(context, alias.countryCode);
        await checkScope(context, scopeLocationId, countryLocationId);
        locationId = await targetLocation(
          context,
          user,
          targetChanged ? { locationId: input.locationId, point: input.point } : { locationId: alias.locationId },
          { scopeLocationId, countryLocationId, name: alias.nameDisplay },
        );
      }

      let updated;
      try {
        updated = await context.prisma.$transaction(async (tx) => {
          // Only the fields this request changes are written, and only while
          // the alias is still the one read above (`updatedAt` moves on each
          // write). So a change made in between is never undone, and a team
          // admin's request never lands on an alias a platform admin has just
          // made country-wide: both get CONFLICT and read again.
          const { count } = await tx.placeAliases.updateMany({
            where: { id, updatedAt: alias.updatedAt },
            data: {
              ...(scopeChanged ? { scopeLocationId } : {}),
              ...(targetChanged ? { locationId } : {}),
              ...(noteChanged ? { note: trimText(input.note, NOTE_MAX, "note") } : {}),
            },
          });
          if (count === 0) throw changedMeanwhile();
          // A queue row this alias answered, in a state the new scope leaves
          // out, has no answer any more: it goes back to open. Its moved
          // Signals stay where they are.
          if (scopeChanged && scopeLocationId !== null) {
            await tx.unresolvedPlaceNames.updateMany({
              where: { placeAliasId: id, status: "resolved", NOT: { stateLocationId: scopeLocationId } },
              data: { status: "open", resolvedById: null, resolvedAt: null, resolutionNote: null, placeAliasId: null },
            });
            await tx.unresolvedPlaceNames.updateMany({
              where: { placeAliasId: id, status: "resolved", stateLocationId: null },
              data: { status: "open", resolvedById: null, resolvedAt: null, resolutionNote: null, placeAliasId: null },
            });
          }
          return tx.placeAliases.findUniqueOrThrow({ where: { id } });
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
        // Only the alias as read above: one changed in between (made
        // country-wide, say) is not this caller's to delete without a new look.
        const gone = await tx.placeAliases.deleteMany({ where: { id, updatedAt: alias.updatedAt } });
        if (gone.count === 0) throw changedMeanwhile();
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
