import { GraphQLError } from "graphql";
import { eventLink } from "../utils/event-link.js";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { isPlatformAdmin, requireContentReader, requireRole, requireTeamContentWriter, requireAdminOrTeamAnalystForLocations } from "../utils/auth-guard.js";
import { logActivity } from "../utils/activity-log.js";
import { logEventChange } from "../utils/event-log.js";
import { createPointLocation, resolvePointsToCommonAncestor, getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { buildEventLocationFilterForTeam } from "../utils/location-scope.js";
import { env } from "../utils/env.js";
import { minSeverityFilterFor } from "../utils/alert-severity.js";
import { anyTypeNrcRelevant, eventIsAllNrcIrrelevant, nrcRelevantGlideCodes } from "../utils/nrc-relevance.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import { alertNotification } from "../services/messaging/templates.js";
import { DEFAULT_LOCALE, type Locale } from "../utils/locales.js";
import { enqueueTranslationDurable } from "../services/translation-queue.js";

/**
 * Build the Prisma `include` clause that folds the active-locale
 * translation row into an entity query. Returns `undefined` for the
 * canonical locale so the include is omitted entirely and the entity
 * query stays trivial.
 *
 * Use on every `events.findMany / findUnique / findFirst` in this
 * resolver so Event.title / Event.description can read translations
 * directly off `parent.translations` instead of going through the
 * per-request translation loader (one extra round-trip per resolver
 * pass + the lazy-enqueue side path).
 */
function eventTranslationsInclude(locale: Locale):
  | { translations: { where: { locale: string } } }
  | undefined {
  if (locale === DEFAULT_LOCALE) return undefined;
  return { translations: { where: { locale } } };
}

import {
  severityToLabel,
  formatCount,
  resolveEmailLocation,
  resolveEventTypeLabel,
  fetchEventSignalLocations,
  fetchEventLocalizedText,
  normaliseUserLocale,
  localizeLocationNames,
  pickLocalizedName,
} from "../utils/alert-email-helpers.js";

type DateAccuracy = "DAY" | "WEEK" | "MONTH" | "YEAR";

interface CreateEventInput {
  title?: string;
  description?: string;
  descriptionSignals?: Record<string, unknown>;
  validFrom: string;
  validTo?: string | null;
  firstSignalCreatedAt: string;
  lastSignalCreatedAt: string;
  startedAt?: string;
  endedAt?: string | null;
  startedAtAccuracy?: DateAccuracy;
  endedAtAccuracy?: DateAccuracy;
  magnitude?: number;
  magnitudeUnit?: string;
  actors?: string[];
  countryIds?: string[];
  originId?: string;
  destinationId?: string;
  locationId?: string;
  types: string[];
  severity?: number;
  populationAffected?: string;
  populationDisplaced?: string;
  casualties?: number;
  rank: number;
  signalIds: string[];
  lat?: number;
  lng?: number;
  /**
   * Team the event is being filed under. Used only for authorisation —
   * any team membership on this team is admitted even without a global
   * admin role. Ignored for platform-level callers; the event itself has
   * no team column.
   */
  teamId?: string;
}

interface UpdateEventInput {
  title?: string;
  description?: string;
  descriptionSignals?: Record<string, unknown>;
  validFrom?: string;
  /** Explicit null clears a known end back to "ongoing / no known end". */
  validTo?: string | null;
  firstSignalCreatedAt?: string;
  lastSignalCreatedAt?: string;
  startedAt?: string;
  endedAt?: string | null;
  startedAtAccuracy?: DateAccuracy | null;
  endedAtAccuracy?: DateAccuracy | null;
  magnitude?: number | null;
  magnitudeUnit?: string | null;
  actors?: string[];
  countryIds?: string[];
  originId?: string;
  destinationId?: string;
  locationId?: string;
  types?: string[];
  severity?: number;
  populationAffected?: string | null;
  populationDisplaced?: string | null;
  casualties?: number;
  rank?: number;
  signalIds?: string[];
}

/** Absent = leave unchanged; explicit null = clear (`?? undefined` would
 *  swallow the null, which is why updateEvent can't be used for this). */
interface EventAggregatesInput {
  severity?: number | null;
  casualties?: number | null;
  populationAffected?: string | null;
  populationDisplaced?: string | null;
  rank: number;
  title?: string | null;
  description?: string | null;
  rewriteMembersHash?: string | null;
  // Absolute writes from the pipeline recompute: null/[] clears a fact no live
  // member supports any more.
  endedAt?: string | null;
  startedAtAccuracy?: DateAccuracy | null;
  endedAtAccuracy?: DateAccuracy | null;
  magnitude?: number | null;
  magnitudeUnit?: string | null;
  actors?: string[] | null;
  countryIds?: string[] | null;
}

/** BigInt column from its decimal-string input, keeping absent (undefined)
 *  and cleared (null) distinct. */
function bigIntOrKeep(value: string | null | undefined, field: string): bigint | null | undefined {
  if (value === undefined || value === null) return value;
  // BigInt() alone would turn "" into 0n and "0x10" into 16n.
  if (!/^-?\d+$/.test(value)) {
    throw new GraphQLError(`${field} must be a decimal integer string`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return BigInt(value);
}

/** Lenient variant for createEvent/updateEvent, whose form callers may send
 *  "", padded or "+"-signed values (all accepted by the old raw BigInt()):
 *  blank/null = absent, whitespace and a leading "+" ignored. */
function optionalBigInt(value: string | null | undefined, field: string): bigint | undefined {
  const trimmed = value?.trim().replace(/^\+/, "");
  return bigIntOrKeep(trimmed ? trimmed : undefined, field) ?? undefined;
}

/** Date column from an ISO string, keeping absent (undefined) and cleared
 *  (null) distinct — so an explicit null clears, an omitted field is untouched. */
function dateOrKeep(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  return new Date(value);
}

/** `countryIds` must reference admin-0 (country) locations. Throws BAD_USER_INPUT
 *  if any id is missing or sits at another level, so a state/city/point can't be
 *  attached as a "country". No-op for an empty/undefined list. */
async function assertCountryLocations(
  prisma: Context["prisma"],
  ids: string[] | null | undefined,
): Promise<void> {
  if (!ids || ids.length === 0) return;
  const unique = [...new Set(ids)];
  const rows = await prisma.locations.findMany({
    where: { id: { in: unique } },
    select: { id: true, level: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r.level]));
  const bad = unique.filter((id) => byId.get(id) !== 0);
  if (bad.length > 0) {
    throw new GraphQLError(
      `countryIds must be admin-0 (country) locations; not a country (or not found): ${bad.join(", ")}`,
      { extensions: { code: "BAD_USER_INPUT" } },
    );
  }
}

export const eventResolvers = {
  Query: {
    events: async (
      _parent: unknown,
      args: { teamId?: string; includeDummy?: boolean; lastSignalSince?: string; limit?: number },
      context: Context,
    ) => {
      requireContentReader(context);
      const dummyFilter = args.includeDummy ? {} : { isDummy: false };
      // Optional SERVER-SIDE bounding so a caller (e.g. the pipeline's grouping
      // drain) can fetch only the recent window instead of the WHOLE events
      // table. Returning every event + its translation includes on a table the
      // drain grows continuously once ran clear-api to 6.2 GB and OOM-killed the
      // host (2026-10-20). Both args are optional — omitted = the original full
      // feed, so existing callers (clear-mvp) are unchanged.
      const recentFilter =
        args.lastSignalSince != null
          ? { lastSignalCreatedAt: { gte: new Date(args.lastSignalSince) } }
          : {};
      // When a limit is given, take the NEWEST rows (bounded fetch must order).
      const bound: { orderBy?: { lastSignalCreatedAt: "desc" }; take?: number } =
        args.limit != null
          ? { orderBy: { lastSignalCreatedAt: "desc" }, take: Math.min(Math.max(args.limit, 1), 5000) }
          : {};
      const include = eventTranslationsInclude(context.locale);
      // No teamId: any authenticated user gets the global feed.
      if (!args.teamId) {
        return context.prisma.events.findMany({
          where: { ...dummyFilter, ...recentFilter },
          ...(include ? { include } : {}),
          ...bound,
        });
      }
      // teamId provided: apply that team's location filter as a view filter
      // (no membership check -  see signals resolver for rationale).
      const filter = await buildEventLocationFilterForTeam(context.prisma, args.teamId);
      return context.prisma.events.findMany({
        where: { ...filter, ...dummyFilter, ...recentFilter },
        ...(include ? { include } : {}),
        ...bound,
      });
    },
    eventsByLocation: async (_parent: unknown, args: { locationId: string }, context: Context) => {
      requireContentReader(context);
      const locationIds = await getLocationIdsWithDescendants(context.prisma, args.locationId);
      const include = eventTranslationsInclude(context.locale);
      return context.prisma.events.findMany({
        where: {
          OR: [
            { originId: { in: locationIds } },
            { destinationId: { in: locationIds } },
            { locationId: { in: locationIds } },
          ],
        },
        ...(include ? { include } : {}),
      });
    },
    // The Dagster alert-stage queue: events that need an alert but don't have
    // one yet — severity at or above `minSeverity` (default 4) AND no alert row
    // (`alerts: { none: {} }`) AND at least one NRC-relevant type. Ordered
    // oldest-first by the event's earliest-signal timestamp so the alert worker
    // drains in ingestion order. `first` caps the batch (default 100, clamped
    // to [1, 500]). Admin/pipeline only.
    eventsPendingAlert: async (
      _parent: unknown,
      args: {
        first?: number | null;
        minSeverity?: number | null;
        maxAgeHours?: number | null;
      },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const take = Math.min(Math.max(args.first ?? 100, 1), 500);
      const minSeverity = args.minSeverity ?? 4;
      // Age bound on the LATEST signal's real-world time: only events that are
      // recently active surface for alerting. This keeps the historical backlog
      // and backdated backfill (e.g. weeks-old ACLED events replayed on ingest)
      // out — such signals are grouped into their event but must NOT alert. 0
      // disables the bound. Default 48h.
      const maxAgeHours = args.maxAgeHours ?? 48;
      const recentOnly =
        maxAgeHours > 0
          ? {
              lastSignalCreatedAt: {
                gte: new Date(Date.now() - maxAgeHours * 3_600_000),
              },
            }
          : {};
      const include = eventTranslationsInclude(context.locale);
      const where = {
        severity: { gte: minSeverity },
        alerts: { none: {} },
        isDummy: false,
        ...recentOnly,
      };

      // NRC-relevance gate, mirroring createAlert: an event whose types are ALL
      // out-of-interest (disaster_types.nrc_relevant = false, or unknown) never
      // gets an alert row, so it must not be queued either — otherwise it is
      // re-sent to createAlert on every drain, forever (the Oct-2026 hot loop:
      // ~2,500 skipped createAlert calls/hour for the same ~10 "ot" events).
      // Filtered in memory rather than in SQL because the match must be
      // case-insensitive (`events.types` may hold "FL", glide_number is "fl")
      // and Prisma's scalar-list filters are not. Pages are re-fetched until
      // `first` is honoured or the queue is exhausted, so a run of irrelevant
      // events can't starve the batch. A page cap bounds the scan when
      // `maxAgeHours: 0` exposes the whole backlog.
      const relevantCodes = await nrcRelevantGlideCodes(context.prisma);
      const MAX_PAGES = 10;
      type Row = Awaited<ReturnType<typeof context.prisma.events.findMany>>[number];
      const out: Row[] = [];
      const seen = new Set<string>();
      let skipped = 0;
      for (let page = 0; page < MAX_PAGES && out.length < take; page++) {
        const skip = page * take;
        const rows: Row[] = await context.prisma.events.findMany({
          where,
          orderBy: [{ firstSignalCreatedAt: "asc" }, { id: "asc" }],
          take,
          ...(skip > 0 ? { skip } : {}),
          ...(include ? { include } : {}),
        });
        for (const e of rows) {
          if (seen.has(e.id)) continue; // offset pagination can repeat a row if the queue shifts between pages
          seen.add(e.id);
          if (eventIsAllNrcIrrelevant(e.types, relevantCodes)) {
            skipped++;
            continue;
          }
          if (out.length < take) out.push(e);
        }
        if (rows.length < take) break; // queue exhausted
      }
      if (skipped > 0) {
        console.log(
          `[eventsPendingAlert] skipped ${skipped} event(s) whose types are all NRC-irrelevant — they will never alert and are not queued`,
        );
      }
      return out;
    },
    event: async (_parent: unknown, args: { id: string }, context: Context) => {
      requireContentReader(context);
      // Only include the event's own translation row eagerly. Field
      // resolvers (Event.signals, Event.{general,origin,destination}-
      // Location) fetch what they need with their own targeted
      // includes — that's faster overall than eagerly fetching every
      // nested branch here. A previous version pulled the whole tree
      // upfront and added a ~2.6s baseline to every event query (even
      // `{ id title }`), which compounded with the field-resolver work
      // on event detail to wedge past 10 minutes.
      const include = eventTranslationsInclude(context.locale);
      return context.prisma.events.findUnique({
        where: { id: args.id },
        ...(include ? { include } : {}),
      });
    },
  },
  Mutation: {
    createEvent: async (
      _parent: unknown,
      args: { input: CreateEventInput },
      context: Context,
    ) => {
      // Global admin may create events for any location; any team member may
      // create when they supply the teamId they're acting on behalf of.
      // See `requireTeamContentWriter`.
      const { input } = args;
      await requireTeamContentWriter(context, input.teamId);
      await assertCountryLocations(context.prisma, input.countryIds);
      // Validated before any write (point location, event row).
      const populationAffected = optionalBigInt(input.populationAffected, "populationAffected");
      const populationDisplaced = optionalBigInt(input.populationDisplaced, "populationDisplaced");

      // Resolve location for the event
      let locationId = input.locationId;
      const originId = input.originId;
      const destinationId = input.destinationId;

      if (!locationId && !originId && !destinationId) {
        if (input.lat != null && input.lng != null) {
          // Single lat/lng provided — create a point location. Title is
          // intentionally not used as the L4 name (see signal.resolver
          // for the same reason: an event title is rarely a place name).
          // The createPointLocation helper will fall back to a
          // coord-based label.
          const pointLoc = await createPointLocation(
            context.prisma, input.lat, input.lng,
          );
          locationId = pointLoc.id;
        } else if (input.signalIds.length > 0) {
          // No explicit location -  gather point geometries from linked signals
          const signalLocations = await context.prisma.signals.findMany({
            where: { id: { in: input.signalIds } },
            select: { locationId: true, originId: true, destinationId: true },
          });

          // Collect unique location IDs from signals
          const locIds = new Set<string>();
          for (const sl of signalLocations) {
            if (sl.locationId) locIds.add(sl.locationId);
            if (sl.originId) locIds.add(sl.originId);
            if (sl.destinationId) locIds.add(sl.destinationId);
          }

          if (locIds.size === 1) {
            // Single signal location — trust it directly, regardless of
            // geometry type. Manual signals frequently attach to an A1
            // (state) or A2 (district) polygon; before this branch existed
            // the resolver fell through to the point-only query below,
            // silently dropped the polygon, and left the event with no
            // location at all — which in turn blocked alert email dispatch
            // because subscription matching keys off event.locationId.
            locationId = [...locIds][0]!;
          } else if (locIds.size > 1) {
            // Fetch point geometries for these locations
            const locPoints = await context.prisma.$queryRaw<
              Array<{ lat: number; lng: number }>
            >`
              SELECT ST_Y("geometry"::geometry) as lat, ST_X("geometry"::geometry) as lng
              FROM "locations"
              WHERE id = ANY(${[...locIds]}::text[])
                AND "geometry" IS NOT NULL
                AND ST_GeometryType("geometry"::geometry) = 'ST_Point'
            `;

            if (locPoints.length >= 1) {
              // Multiple points (or one point alongside polygons) —
              // attribute the event to the deepest admin polygon containing
              // every point (A2 if same district, A1 if same state, A0
              // otherwise). Keeps `locations` purely administrative instead
              // of accreting a convex-hull region row per event.
              const ancestor = await resolvePointsToCommonAncestor(
                context.prisma, locPoints,
              );
              if (ancestor) locationId = ancestor.id;
            } else {
              // No point-geometry signals — the analyst attached each
              // signal to an admin polygon (A0/A1/A2). Pick the deepest
              // one as the event location. Strictly an approximation when
              // those polygons sit in different branches of the hierarchy
              // (e.g. two distinct A2s), but strictly better than leaving
              // the event with no location and blocking alert dispatch.
              const deepest = await context.prisma.locations.findFirst({
                where: { id: { in: [...locIds] } },
                orderBy: { level: "desc" },
                select: { id: true },
              });
              if (deepest) locationId = deepest.id;
            }
          }
        }
      }

      const event = await context.prisma.events.create({
        data: {
          title: input.title,
          description: input.description,
          description_signals: input.descriptionSignals
            ? (input.descriptionSignals as InputJsonValue)
            : undefined,
          validFrom: new Date(input.validFrom),
          validTo: input.validTo ? new Date(input.validTo) : null,
          firstSignalCreatedAt: new Date(input.firstSignalCreatedAt),
          lastSignalCreatedAt: new Date(input.lastSignalCreatedAt),
          startedAt: input.startedAt ? new Date(input.startedAt) : undefined,
          endedAt: input.endedAt ? new Date(input.endedAt) : undefined,
          startedAtAccuracy: input.startedAtAccuracy ?? undefined,
          endedAtAccuracy: input.endedAtAccuracy ?? undefined,
          magnitude: input.magnitude ?? undefined,
          magnitudeUnit: input.magnitudeUnit ?? undefined,
          actors: input.actors ?? undefined,
          ...(input.countryIds && input.countryIds.length > 0
            ? { countries: { connect: input.countryIds.map((id) => ({ id })) } }
            : {}),
          originId,
          destinationId,
          locationId,
          types: input.types,
          severity: input.severity,
          populationAffected,
          populationDisplaced,
          casualties: input.casualties,
          rank: input.rank,
        },
      });

      // Create signalEvents join entries (dedupe the input array first so
      // the same signalId repeated in the request doesn't create duplicate links).
      const uniqueSignalIds = [...new Set(input.signalIds)];
      if (uniqueSignalIds.length > 0) {
        await context.prisma.signalEvents.createMany({
          data: uniqueSignalIds.map((signalId) => ({
            signalId,
            eventId: event.id,
            collectedAt: new Date(),
          })),
        });
      }

      logEventChange("created", event, uniqueSignalIds);

      const actor = context.user;
      if (actor) {
        void logActivity(context.prisma, {
          userId: actor.id,
          action: "event.create",
          resourceType: "event",
          resourceId: event.id,
          metadata: {
            title: event.title,
            types: event.types,
            severity: event.severity,
            signalCount: input.signalIds.length,
          },
        });
      }

      return event;
    },

    // Overwrites an event's aggregates with values the pipeline recomputed from
    // its live members. Absent fields are kept; explicit nulls clear them.
    setEventAggregates: async (
      _parent: unknown,
      args: { id: string; input: EventAggregatesInput; members: { id: string; revision: number }[] },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const { id, input, members } = args;
      await assertCountryLocations(context.prisma, input.countryIds);
      const data = {
        severity: input.severity,
        casualties: input.casualties,
        populationAffected: bigIntOrKeep(input.populationAffected, "populationAffected"),
        populationDisplaced: bigIntOrKeep(input.populationDisplaced, "populationDisplaced"),
        rank: input.rank,
        title: input.title,
        description: input.description,
        rewriteMembersHash: input.rewriteMembersHash,
        // Absolute aggregate writes — null/[] clears a withdrawn fact.
        endedAt: dateOrKeep(input.endedAt),
        startedAtAccuracy: input.startedAtAccuracy,
        endedAtAccuracy: input.endedAtAccuracy,
        magnitude: input.magnitude,
        magnitudeUnit: input.magnitudeUnit,
        actors: input.actors ?? undefined,
        ...(input.countryIds != null
          ? { countries: { set: input.countryIds.map((cid) => ({ id: cid })) } }
          : {}),
      };
      const sent = new Map(members.map((m) => [m.id, m.revision]));
      // Would otherwise read as stale and be silently dropped.
      if (sent.size !== members.length) {
        throw new GraphQLError("members has duplicate ids", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const updated = await context.prisma.$transaction(async (tx) => {
        // Serialises writers per event: the member check below sees every
        // write committed by an earlier writer.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "events" WHERE id = ${id} FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new GraphQLError("Event not found", {
            extensions: { code: "NOT_FOUND" },
          });
        }

        // Totals computed from a stale member snapshot must not overwrite newer
        // ones. A change committed after this check leaves its signal pending,
        // so a later recompute writes after this one.
        const live = await tx.signals.findMany({
          where: { retracted: false, signalEvents: { some: { eventId: id } } },
          select: { id: true, revision: true },
        });
        const stale =
          live.length !== sent.size || live.some((s) => sent.get(s.id) !== s.revision);
        if (stale) {
          throw new GraphQLError(
            "Event members changed since they were read; a newer recompute supersedes this one",
            { extensions: { code: "STALE_EVENT_MEMBERS" } },
          );
        }

        return tx.events.update({ where: { id }, data });
      });
      logEventChange("aggregates", updated, [], sent.size);
      return updated;
    },

    updateEvent: async (
      _parent: unknown,
      args: { id: string; input: UpdateEventInput },
      context: Context,
    ) => {
      const { id, input } = args;
      // Validated before signal linking. Null/blank = no change, like the other fields here.
      const populationAffected = optionalBigInt(input.populationAffected, "populationAffected");
      const populationDisplaced = optionalBigInt(input.populationDisplaced, "populationDisplaced");

      const existing = await context.prisma.events.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Elevated gate, scoped to the event's locations: admin passes, else the
      // caller must be a team analyst whose location scope covers the event.
      await requireAdminOrTeamAnalystForLocations(context, [
        existing.originId,
        existing.destinationId,
        existing.locationId,
      ]);
      await assertCountryLocations(context.prisma, input.countryIds);

      // Update signal links -  ADDITIVE + IDEMPOTENT semantics. Passing
      // signalIds appends them to the event; already-linked signals are
      // skipped. Callers that want to fully replace links should delete
      // them explicitly (no current use case).
      let newlyLinked: string[] = [];
      if (input.signalIds !== undefined && input.signalIds.length > 0) {
        const alreadyLinked = await context.prisma.signalEvents.findMany({
          where: {
            eventId: id,
            signalId: { in: input.signalIds },
          },
          select: { signalId: true },
        });
        const linkedSet = new Set(alreadyLinked.map((r) => r.signalId));
        const toLink = input.signalIds.filter((sid) => !linkedSet.has(sid));
        newlyLinked = toLink;
        if (toLink.length > 0) {
          await context.prisma.signalEvents.createMany({
            data: toLink.map((signalId) => ({
              signalId,
              eventId: id,
              collectedAt: new Date(),
            })),
          });
        }
      }

      // The signal-time bounds only ever widen. Signals arrive out of order
      // (a backdated ACLED/IDMC record, a delayed Dataminr item), and a
      // stale lastSignalCreatedAt drops a live Event out of grouping's
      // active window and eventsPendingAlert's 48h window. Each bound is a
      // conditional updateMany, so the comparison runs inside the row-locked
      // UPDATE rather than against `existing`, which a concurrent writer may
      // have already moved. They run before the main update so the row it
      // returns carries the result, and in one transaction with it so a
      // failed update (bad locationId, say) leaves the bounds untouched.
      const updated = await context.prisma.$transaction(async (tx) => {
        if (input.lastSignalCreatedAt) {
          const last = new Date(input.lastSignalCreatedAt);
          await tx.events.updateMany({
            where: { id, lastSignalCreatedAt: { lt: last } },
            data: { lastSignalCreatedAt: last },
          });
        }
        if (input.firstSignalCreatedAt) {
          const first = new Date(input.firstSignalCreatedAt);
          await tx.events.updateMany({
            where: { id, firstSignalCreatedAt: { gt: first } },
            data: { firstSignalCreatedAt: first },
          });
        }

        return tx.events.update({
          where: { id },
          data: {
            title: input.title ?? undefined,
            description: input.description ?? undefined,
            description_signals: input.descriptionSignals
              ? (input.descriptionSignals as InputJsonValue)
              : undefined,
            validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
            // null clears the end date; omitted leaves it untouched.
            validTo:
              input.validTo === null ? null : input.validTo ? new Date(input.validTo) : undefined,
            startedAt: input.startedAt ? new Date(input.startedAt) : undefined,
            // null clears; omitted leaves untouched. Same for the accuracy +
            // magnitude fields — pass null through so a correction can clear them.
            endedAt: dateOrKeep(input.endedAt),
            startedAtAccuracy: input.startedAtAccuracy,
            endedAtAccuracy: input.endedAtAccuracy,
            magnitude: input.magnitude,
            magnitudeUnit: input.magnitudeUnit,
            actors: input.actors ?? undefined,
            // Provided (even empty) → replace the country set; omitted → leave as-is.
            ...(input.countryIds != null
              ? { countries: { set: input.countryIds.map((cid) => ({ id: cid })) } }
              : {}),
            originId: input.originId,
            destinationId: input.destinationId,
            locationId: input.locationId,
            types: input.types ?? undefined,
            severity: input.severity ?? undefined,
            populationAffected,
            populationDisplaced,
            casualties: input.casualties ?? undefined,
            rank: input.rank ?? undefined,
          },
        });
      });
      logEventChange("updated", updated, [...new Set(newlyLinked)]);
      return updated;
    },

    deleteEvent: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.events.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.events.delete({ where: { id: args.id } });
      return true;
    },

    escalateEvent: async (
      _parent: unknown,
      args: { eventId: string; userId: string; teamId?: string },
      context: Context,
    ) => {
      // Global admin may escalate any event; any team member may escalate
      // when they pass the teamId they're acting on behalf of. The worker
      // role and non-members are rejected. See `requireTeamContentWriter`.
      await requireTeamContentWriter(context, args.teamId);

      const event = await context.prisma.events.findUnique({
        where: { id: args.eventId },
      });
      if (!event) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Escalation auto-publishes an alert, so apply the same NRC gate: refuse
      // when the event's types are ALL out-of-interest
      // (disaster_types.nrc_relevant = false). One relevant type is enough to
      // pass; an event with no classified types is not blocked here.
      if (
        (event.types?.length ?? 0) > 0 &&
        !(await anyTypeNrcRelevant(context.prisma, event.types))
      ) {
        throw new GraphQLError(
          "Cannot escalate: none of this event's types are relevant to NRC",
          { extensions: { code: "NRC_IRRELEVANT" } },
        );
      }

      // Check if an alert already exists for this event
      const existingAlert = await context.prisma.alerts.findFirst({
        where: { eventId: args.eventId, status: "published" },
      });

      // Create alert if none exists, and fan out notifications
      if (!existingAlert) {
        const alert = await context.prisma.alerts.create({
          data: { eventId: args.eventId, status: "published" },
        });

        // Fan out notifications to subscribers
        const eventLocationIds = [
          event.originId,
          event.destinationId,
          event.locationId,
        ].filter((id): id is string => id !== null);

        console.log(`[escalateEvent] Event ${event.id}: types=${JSON.stringify(event.types)}, locationIds=${JSON.stringify(eventLocationIds)}`);

        if (eventLocationIds.length === 0) {
          console.log("[escalateEvent] No locations on event -  skipping subscriber notifications");
        } else if (event.types.length === 0) {
          console.log("[escalateEvent] No types on event -  skipping subscriber notifications");
        }

        if (eventLocationIds.length > 0 && event.types.length > 0) {
          // Expand to include ancestor locations
          const allLocationIds = new Set(eventLocationIds);
          const locations = await context.prisma.locations.findMany({
            where: { id: { in: eventLocationIds } },
            select: { id: true, name: true, level: true, population: true, ancestorIds: true },
          });
          for (const loc of locations) {
            for (const aid of loc.ancestorIds) allLocationIds.add(aid);
          }

          const locationNames = locations.map((l) => l.name).join(", ");
          console.log(`[escalateEvent] Searching subscribers for types=${JSON.stringify(event.types)}, locations=[${locationNames}] (${allLocationIds.size} IDs including ancestors)`);

          // Unknown (null) severity reaches only "all severities" subscribers.
          const subscriptions = await context.prisma.userAlertSubscriptions.findMany({
            where: {
              active: true,
              frequency: "immediately",
              alertType: { in: event.types },
              locationId: { in: [...allLocationIds] },
              minSeverity: minSeverityFilterFor(event.severity),
            },
            select: { userId: true },
          });

          const uniqueUserIds = [...new Set(subscriptions.map((s) => s.userId))];
          console.log(`[escalateEvent] Found ${subscriptions.length} subscriptions → ${uniqueUserIds.length} unique users`);

          if (uniqueUserIds.length === 0) {
            console.log(`[escalateEvent] No subscribers found for locations=[${locationNames}] and types=${JSON.stringify(event.types)}`);
          }

          if (uniqueUserIds.length > 0) {
            const fallbackTitle = event.types[0] ?? "Alert";
            const alertUrl = eventLink(event.id, "email", env.FRONTEND_URL);
            const primaryLoc =
              locations.find((l) => l.id === event.locationId) ??
              locations.find((l) => l.id === event.originId) ??
              locations.find((l) => l.id === event.destinationId) ??
              null;

            // Recipients up front — drives both the in-app message text
            // below and the per-recipient email body further down so
            // each user sees the title/description in their own
            // language. One Prisma read covers both paths.
            const recipients = await context.prisma.user.findMany({
              where: { id: { in: uniqueUserIds } },
              select: { id: true, name: true, email: true, language: true, emailNotification: true },
            });
            const uniqueLocales = [
              ...new Set(recipients.map((r) => normaliseUserLocale(r.language))),
            ];
            const [emailLoc, eventTypeLabel, signalLocs, localizedText] = await Promise.all([
              resolveEmailLocation(context.prisma, primaryLoc),
              resolveEventTypeLabel(context.prisma, event.types),
              fetchEventSignalLocations(context.prisma, event.id),
              fetchEventLocalizedText(
                context.prisma,
                event.id,
                event.title,
                event.description,
                uniqueLocales,
              ),
            ]);
            const titleFor = (locale: string | null) =>
              localizedText.get(normaliseUserLocale(locale))?.title ?? fallbackTitle;
            const descriptionFor = (locale: string | null) =>
              localizedText.get(normaliseUserLocale(locale))?.description ?? event.description;

            // Localized names for every location id that may appear
            // in any per-recipient email. One Prisma read covers all
            // (id, locale) pairs.
            const locIdsForLocalization = [
              ...(primaryLoc?.id ? [primaryLoc.id] : []),
              ...(emailLoc?.id ? [emailLoc.id] : []),
              ...signalLocs.ids,
            ];
            const localizedNames = await localizeLocationNames(
              context.prisma,
              locIdsForLocalization,
              uniqueLocales,
            );

            const severityLabel = severityToLabel(event.severity);
            const population = emailLoc?.population ? formatCount(emailLoc.population) : null;
            const affectedPeople = event.populationAffected != null ? formatCount(event.populationAffected) : null;

            // 1. Populate userAlerts
            await context.prisma.userAlerts.createMany({
              data: uniqueUserIds.map((userId) => ({
                userId,
                alertId: alert.id,
              })),
              skipDuplicates: true,
            });
            console.log(`[escalateEvent] Created ${uniqueUserIds.length} userAlert records`);

            // 2. In-app notifications (per-recipient title localization).
            await context.prisma.notifications.createMany({
              data: recipients.map((r) => ({
                userId: r.id,
                message: `New alert: ${titleFor(r.language)}`,
                notificationType: "alert",
                actionUrl: eventLink(event.id, "inbox"),
                actionText: "View Alert",
              })),
            });
            console.log(`[escalateEvent] Created ${recipients.length} in-app notifications`);

            // 3. Email notifications (fire-and-forget)
            const emailUsers = recipients.filter((r) => r.emailNotification);

            console.log(`[escalateEvent] ${emailUsers.length}/${recipients.length} users have email notifications enabled`);

            if (emailUsers.length > 0) {
              const emailList = emailUsers.map((u) => u.email).join(", ");
              console.log(`[escalateEvent] Sending emails to: ${emailList}`);
              void (async () => {
                try {
                  const emailProvider = await getEmailProvider();
                  await emailProvider.sendBulk(
                    emailUsers
                      .filter((u) => u.email)
                      .map((u) => {
                        // Per-recipient locale — every location name
                        // swaps to the user's language when a
                        // translation row exists, otherwise canonical
                        // English.
                        const recipientLocale = normaliseUserLocale(u.language);
                        const localizedSignalNames = signalLocs.ids
                          .map((id, idx) =>
                            pickLocalizedName(
                              localizedNames,
                              id,
                              recipientLocale,
                              signalLocs.names[idx] ?? null,
                            ) ?? signalLocs.names[idx],
                          )
                          .filter((n): n is string => !!n);
                        const content = alertNotification(
                          u.name,
                          titleFor(u.language),
                          descriptionFor(u.language),
                          alertUrl,
                          {
                            severity: severityLabel,
                            eventType: eventTypeLabel,
                            locationName: pickLocalizedName(
                              localizedNames,
                              emailLoc?.id,
                              recipientLocale,
                              emailLoc?.name ?? null,
                            ),
                            population,
                            affectedPeople,
                            districtName: pickLocalizedName(
                              localizedNames,
                              primaryLoc?.id,
                              recipientLocale,
                              primaryLoc?.name ?? null,
                            ),
                            signalLocations: localizedSignalNames,
                            signalLocationsOverflow: signalLocs.overflow,
                            // Drives the template's chrome (greeting,
                            // labels, CTA, subject, html dir/lang).
                            locale: recipientLocale,
                          },
                        );
                        return {
                          to: u.email!,
                          subject: content.subject,
                          textBody: content.textBody,
                          htmlBody: content.htmlBody,
                        };
                      }),
                  );
                  console.log(`[escalateEvent] Email sent successfully to ${emailUsers.length} users`);
                } catch (err) {
                  console.error("[escalateEvent] Failed to send alert emails:", err);
                }
              })();
            } else {
              console.log("[escalateEvent] No users with email notifications enabled -  skipping emails");
            }
          }
        }
      }

      // Record user escalation (upsert to handle idempotency)
      const escalation = await context.prisma.eventEscaladedByUsers.upsert({
        where: {
          userId_eventId: { userId: args.userId, eventId: args.eventId },
        },
        create: {
          userId: args.userId,
          eventId: args.eventId,
          validFrom: new Date(),
          validTo: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        },
        update: {},
      });

      return escalation;
    },
  },
  Event: {
    // Localized overlay. Prefers `parent.translations` when the caller
    // fetched the event via `events.findMany / findUnique` with
    // `include: eventTranslationsInclude(locale)` — that's now the
    // default in this resolver's Query.event{,s,ByLocation}. Falls
    // back to the per-request translationLoader for entry points that
    // didn't include translations (Alert.event, Crisis.events, etc.)
    // so this rewire can land without touching every event-producing
    // resolver in one PR. At locale === "en" both paths short-circuit
    // to the canonical column.
    title: async (
      parent: {
        id: string;
        title: string | null;
        translations?: Array<{ data: unknown }>;
      },
      _args: unknown,
      context: Context,
    ) => {
      if (context.locale === DEFAULT_LOCALE) return parent.title;
      if (parent.translations !== undefined) {
        const data = parent.translations[0]?.data as
          | { title?: unknown }
          | undefined;
        const localized = data?.title;
        if (typeof localized === "string") return localized;
        if (parent.translations.length === 0) {
          enqueueTranslationDurable(context.prisma, "event", parent.id, context.locale);
        }
        return parent.title;
      }
      const tr = await context.translationLoader.load("event", parent.id);
      const localized = tr?.title;
      return typeof localized === "string" ? localized : parent.title;
    },
    description: async (
      parent: {
        id: string;
        description: string | null;
        translations?: Array<{ data: unknown }>;
      },
      _args: unknown,
      context: Context,
    ) => {
      if (context.locale === DEFAULT_LOCALE) return parent.description;
      if (parent.translations !== undefined) {
        const data = parent.translations[0]?.data as
          | { description?: unknown }
          | undefined;
        const localized = data?.description;
        if (typeof localized === "string") return localized;
        if (parent.translations.length === 0) {
          enqueueTranslationDurable(context.prisma, "event", parent.id, context.locale);
        }
        return parent.description;
      }
      const tr = await context.translationLoader.load("event", parent.id);
      const localized = tr?.description;
      return typeof localized === "string" ? localized : parent.description;
    },
    signals: (
      parent: {
        id: string;
        signalEvents?: Array<{ signal: unknown }>;
      },
      _args: unknown,
      context: Context,
      info: import("graphql").GraphQLResolveInfo,
    ) => {
      // Fast path: pre-loaded from a deeper include.
      // Retracted signals keep their link (retraction is reversible) but are hidden,
      // matching their exclusion from the event's aggregates.
      if (parent.signalEvents) {
        return parent.signalEvents
          .map((l) => l.signal)
          .filter((s) => (s as { retracted?: boolean }).retracted !== true);
      }
      // Inspect the GraphQL selection to decide whether to include
      // signal-locations + their translations. /detection's events tab
      // asks for `signals { generalLocation { ... } ... }` and needs
      // the include to avoid the N+1 fan-out (25 events × 10 signals ×
      // 3 locations = 750 findUnique calls through the SSH tunnel).
      // Signal detail page asks for nested `events.signals` WITHOUT
      // locations — including them there is pure overhead that wedges
      // the page payload through the tunnel. Probing `info.fieldNodes`
      // gives us per-call accuracy without resolver-per-context
      // duplication.
      const selections = info.fieldNodes[0]?.selectionSet?.selections ?? [];
      const needsLocations = selections.some(
        (sel) =>
          sel.kind === "Field" &&
          (sel.name.value === "generalLocation" ||
            sel.name.value === "originLocation" ||
            sel.name.value === "destinationLocation"),
      );

      const tr =
        context.locale === DEFAULT_LOCALE
          ? undefined
          : { translations: { where: { locale: context.locale } } };
      const locInclude = tr ? { include: tr } : undefined;
      const signalInclude = {
        source: true as const,
        ...(needsLocations && locInclude
          ? {
              generalLocation: locInclude,
              originLocation: locInclude,
              destinationLocation: locInclude,
            }
          : {}),
      };
      return context.prisma.signalEvents
        .findMany({
          where: { eventId: parent.id, signal: { retracted: false } },
          include: { signal: { include: signalInclude } },
          take: 50,
          // Intentionally no orderBy: ordering by signal.publishedAt
          // requires a JOIN with the signals table and was the wedge
          // on signal detail (25 events × slow JOIN per event). The UI
          // can sort the small returned set client-side if needed.
        })
        .then((links) => links.map((l) => l.signal));
    },
    // Fast path on all three: deep-include from eventsPage / alertsPage
    // pre-loaded the location (with translations) onto the parent. Fall
    // back to findUnique-with-include for paths that didn't pre-load
    // (Query.event detail, Crisis.events, etc.).
    originLocation: (
      parent: { originId: string | null; originLocation?: unknown },
      _args: unknown,
      context: Context,
    ) => {
      if (parent.originLocation !== undefined) return parent.originLocation;
      if (!parent.originId) return null;
      const include = context.locale === DEFAULT_LOCALE
        ? undefined
        : { translations: { where: { locale: context.locale } } };
      return context.prisma.locations.findUnique({
        where: { id: parent.originId },
        ...(include ? { include } : {}),
      });
    },
    destinationLocation: (
      parent: { destinationId: string | null; destinationLocation?: unknown },
      _args: unknown,
      context: Context,
    ) => {
      if (parent.destinationLocation !== undefined) return parent.destinationLocation;
      if (!parent.destinationId) return null;
      const include = context.locale === DEFAULT_LOCALE
        ? undefined
        : { translations: { where: { locale: context.locale } } };
      return context.prisma.locations.findUnique({
        where: { id: parent.destinationId },
        ...(include ? { include } : {}),
      });
    },
    generalLocation: (
      parent: { locationId: string | null; generalLocation?: unknown },
      _args: unknown,
      context: Context,
    ) => {
      if (parent.generalLocation !== undefined) return parent.generalLocation;
      if (!parent.locationId) return null;
      const include = context.locale === DEFAULT_LOCALE
        ? undefined
        : { translations: { where: { locale: context.locale } } };
      return context.prisma.locations.findUnique({
        where: { id: parent.locationId },
        ...(include ? { include } : {}),
      });
    },
    representativePoint: (
      parent: { id: string; representativePoint?: unknown },
      _args: unknown,
      context: Context,
    ) => {
      if (parent.representativePoint !== undefined) return parent.representativePoint;
      return context.representativePointLoader.load(parent.id);
    },
    countries: (
      parent: { id: string; countries?: unknown },
      _args: unknown,
      context: Context,
    ) => {
      // Fast path: preloaded via a deep include. Otherwise walk the m2m,
      // carrying the viewer's locale for translated location names.
      if (parent.countries !== undefined) return parent.countries;
      const include = context.locale === DEFAULT_LOCALE
        ? undefined
        : { translations: { where: { locale: context.locale } } };
      return context.prisma.events
        .findUnique({ where: { id: parent.id } })
        .countries(include ? { include } : undefined);
    },
    alerts: (
      parent: { id: string; alerts?: unknown[] },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (parent.alerts !== undefined) return parent.alerts;
      return prisma.alerts.findMany({ where: { eventId: parent.id } });
    },
    // Same visibility split as Crisis.feedbacks / comments: admin sees all;
    // member sees only their own; everyone else gets empty. (analyst is no
    // longer a global role, so it no longer grants a global all-rows view
    // here.) See crisis.resolver for the rationale.
    feedbacks: (parent: { id: string }, _args: unknown, ctx: Context) => {
      const role = ctx.user?.role ?? "";
      if (isPlatformAdmin(ctx.user)) {
        return ctx.prisma.userFeedbacks.findMany({ where: { eventId: parent.id } });
      }
      if (role === "member" && ctx.user) {
        return ctx.prisma.userFeedbacks.findMany({
          where: { eventId: parent.id, userId: ctx.user.id },
        });
      }
      return [];
    },
    comments: (parent: { id: string }, _args: unknown, ctx: Context) => {
      const role = ctx.user?.role ?? "";
      if (isPlatformAdmin(ctx.user)) {
        return ctx.prisma.userComments.findMany({ where: { eventId: parent.id } });
      }
      if (role === "member" && ctx.user) {
        return ctx.prisma.userComments.findMany({
          where: { eventId: parent.id, userId: ctx.user.id },
        });
      }
      return [];
    },
    // Map Prisma snake_case field to GraphQL camelCase
    descriptionSignals: (parent: { description_signals?: unknown }) => {
      return parent.description_signals ?? null;
    },
    populationAffected: (parent: { populationAffected: bigint | null }) => {
      return parent.populationAffected?.toString() ?? null;
    },
    populationDisplaced: (parent: { populationDisplaced: bigint | null }) => {
      return parent.populationDisplaced?.toString() ?? null;
    },
    escalations: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.eventEscaladedByUsers.findMany({ where: { eventId: parent.id } });
    },
  },
  EventEscalation: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    event: (parent: { eventId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.events.findUnique({ where: { id: parent.eventId } });
    },
  },
};
