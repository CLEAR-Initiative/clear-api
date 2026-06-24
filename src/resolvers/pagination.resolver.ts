import { Prisma } from "../generated/prisma/client.js";
import type { Context } from "../context.js";
import { requireContentReader } from "../utils/auth-guard.js";
import {
  buildEventLocationFilterForTeam,
  buildLocationFilterForTeam,
} from "../utils/location-scope.js";
import { getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { DEFAULT_LOCALE, type Locale } from "../utils/locales.js";

// ─── Constants ───────────────────────────────────────────────────────────
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Build the Prisma `include` clause that folds the active-locale
 * translation row into a paginated entity query. Same shape as the
 * helpers in event/crisis/location resolvers — kept local so the
 * pagination resolver doesn't need to cross-import them. Returns
 * undefined for the canonical locale so the include is omitted.
 *
 * Used on eventsPage / alertsPage / signalsPage so the Event /
 * Location field resolvers can read translations off `parent.translations`
 * instead of going through the per-request translationLoader on every
 * page render at non-English locales — that loader path adds one extra
 * DB round-trip per entity type and the lazy-enqueue side path that
 * wedged the resolver at high miss counts (see 2026-06-17 incident).
 */
function entityTranslationsInclude(
  locale: Locale,
):
  | { translations: { where: { locale: string } } }
  | undefined {
  if (locale === DEFAULT_LOCALE) return undefined;
  return { translations: { where: { locale } } };
}

/**
 * Prisma include for the event-shape used by list views and the
 * event detail page. Folds the event's own direct relationships
 * (translations, 3 locations + their translations, alerts) so the
 * Event.title/description and Location.name field resolvers hit the
 * fast path off `parent.<field>`. We deliberately do NOT include
 * `signalEvents → signal → locations` here — that chain is 4 levels
 * deep and produced a wedge at non-English locales when an event had
 * many signals. Signals + their nested locations fall back to the
 * existing field-resolver + translationLoader path, which already
 * batches per-entity-type into one query per microtask boundary and
 * is fast in practice.
 */
function deepEventInclude(locale: Locale) {
  const tr = entityTranslationsInclude(locale);
  if (!tr) return undefined;
  const locInclude = { include: tr };
  return {
    translations: tr.translations,
    generalLocation: locInclude,
    originLocation: locInclude,
    destinationLocation: locInclude,
    alerts: true as const,
  };
}

/**
 * Deep Prisma include for the signal shape used by signalsPage. Signals
 * aren't translatable themselves, but their nested locations need
 * translations folded in so Location.name uses the fast path.
 */
function deepSignalInclude(locale: Locale) {
  const tr = entityTranslationsInclude(locale);
  if (!tr) return undefined;
  const locInclude = { include: tr };
  return {
    generalLocation: locInclude,
    originLocation: locInclude,
    destinationLocation: locInclude,
  };
}

function clampLimit(limit?: number | null): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(limit));
}

function clampOffset(offset?: number | null): number {
  if (!offset || offset < 0) return 0;
  return Math.floor(offset);
}

// ─── Filter shape (shared between page + stats inputs) ───────────────────
type AlertStatus = "draft" | "published" | "archived";

interface CommonFilter {
  teamId?: string | null;
  locationId?: string | null;
  eventTypes?: string[] | null;
  severityMin?: number | null;
  severityMax?: number | null;
  from?: Date | string | null;
  to?: Date | string | null;
  includeDummy?: boolean | null;
}

interface AlertsFilter extends CommonFilter {
  status?: AlertStatus | null;
}

interface EventsFilter extends CommonFilter {}

interface SignalsFilter extends Omit<CommonFilter, "eventTypes"> {
  sourceNames?: string[] | null;
}

// ─── where-clause builders ───────────────────────────────────────────────

/** Severity range → Prisma `Int` filter; returns undefined when no bound set. */
function severityFilter(min?: number | null, max?: number | null) {
  if (min == null && max == null) return undefined;
  const f: Prisma.IntNullableFilter = {};
  if (min != null) f.gte = min;
  if (max != null) f.lte = max;
  return f;
}

/** Date range → Prisma DateTime filter; undefined when no bound set. */
function dateFilter(from?: Date | string | null, to?: Date | string | null) {
  if (!from && !to) return undefined;
  const f: Prisma.DateTimeFilter = {};
  if (from) f.gte = new Date(from);
  if (to) f.lte = new Date(to);
  return f;
}

/**
 * Resolve a `locationId` to "this location OR any descendant", expressed as
 * an event-shaped where (origin / destination / general). Returns null when
 * no locationId given.
 */
async function locationWhereForEvent(
  prisma: Context["prisma"],
  locationId?: string | null,
) {
  if (!locationId) return null;
  const ids = await getLocationIdsWithDescendants(prisma, locationId);
  if (ids.length === 0) return null;
  return {
    OR: [
      { originId: { in: ids } },
      { destinationId: { in: ids } },
      { locationId: { in: ids } },
    ],
  } satisfies Prisma.eventsWhereInput;
}

async function locationWhereForSignal(
  prisma: Context["prisma"],
  locationId?: string | null,
) {
  if (!locationId) return null;
  const ids = await getLocationIdsWithDescendants(prisma, locationId);
  if (ids.length === 0) return null;
  return {
    OR: [
      { originId: { in: ids } },
      { destinationId: { in: ids } },
      { locationId: { in: ids } },
    ],
  } satisfies Prisma.signalsWhereInput;
}

async function buildEventsWhere(
  prisma: Context["prisma"],
  f: EventsFilter,
): Promise<Prisma.eventsWhereInput> {
  const ands: Prisma.eventsWhereInput[] = [];

  if (!f.includeDummy) ands.push({ isDummy: false });
  if (f.eventTypes && f.eventTypes.length > 0) {
    ands.push({ types: { hasSome: f.eventTypes } });
  }
  const sev = severityFilter(f.severityMin, f.severityMax);
  if (sev) ands.push({ severity: sev });
  const dt = dateFilter(f.from, f.to);
  if (dt) ands.push({ firstSignalCreatedAt: dt });

  if (f.teamId) {
    const teamScope = await buildEventLocationFilterForTeam(prisma, f.teamId);
    if (teamScope && Object.keys(teamScope).length > 0) {
      ands.push(teamScope as Prisma.eventsWhereInput);
    }
  }

  const locWhere = await locationWhereForEvent(prisma, f.locationId);
  if (locWhere) ands.push(locWhere);

  return ands.length > 0 ? { AND: ands } : {};
}

async function buildSignalsWhere(
  prisma: Context["prisma"],
  f: SignalsFilter,
): Promise<Prisma.signalsWhereInput> {
  const ands: Prisma.signalsWhereInput[] = [];

  if (!f.includeDummy) ands.push({ isDummy: false });
  const sev = severityFilter(f.severityMin, f.severityMax);
  if (sev) ands.push({ severity: sev });
  const dt = dateFilter(f.from, f.to);
  if (dt) ands.push({ publishedAt: dt });

  if (f.sourceNames && f.sourceNames.length > 0) {
    ands.push({ source: { name: { in: f.sourceNames } } });
  }

  if (f.teamId) {
    const teamScope = await buildLocationFilterForTeam(prisma, f.teamId);
    if (teamScope && Object.keys(teamScope).length > 0) {
      ands.push(teamScope as Prisma.signalsWhereInput);
    }
  }

  const locWhere = await locationWhereForSignal(prisma, f.locationId);
  if (locWhere) ands.push(locWhere);

  return ands.length > 0 ? { AND: ands } : {};
}

async function buildAlertsWhere(
  prisma: Context["prisma"],
  f: AlertsFilter,
): Promise<Prisma.alertsWhereInput> {
  const ands: Prisma.alertsWhereInput[] = [];

  if (f.status) ands.push({ status: f.status });

  // All event-side filters are pushed under `event: { ... }`.
  const eventFilter = await buildEventsWhere(prisma, f);
  if (eventFilter && Object.keys(eventFilter).length > 0) {
    ands.push({ event: eventFilter });
  }

  return ands.length > 0 ? { AND: ands } : {};
}

// ─── orderBy mapping ─────────────────────────────────────────────────────
// Each orderBy returns an array so we can append a deterministic tie-breaker
// (final `id` sort). Without one, rows tied on the primary sort field can
// appear on different pages between requests, surfacing as "newest items
// scattered across pages" in the UI.
type AlertOrderBy = "CREATED_DESC" | "CREATED_ASC" | "SEVERITY_DESC" | "SEVERITY_ASC";
type EventOrderBy =
  | "LAST_SIGNAL_DESC"
  | "LAST_SIGNAL_ASC"
  | "CREATED_DESC"
  | "CREATED_ASC"
  | "SEVERITY_DESC"
  | "SEVERITY_ASC";
type SignalOrderBy = "PUBLISHED_DESC" | "PUBLISHED_ASC" | "SEVERITY_DESC" | "SEVERITY_ASC";

function alertsOrderBy(o?: AlertOrderBy | null): Prisma.alertsOrderByWithRelationInput[] {
  // Severity ties resolve to newest-first within the tier, then to a stable
  // id order so paging is deterministic.
  switch (o) {
    case "CREATED_ASC":
      return [{ event: { firstSignalCreatedAt: "asc" } }, { id: "asc" }];
    case "SEVERITY_DESC":
      return [
        { event: { severity: "desc" } },
        { event: { firstSignalCreatedAt: "desc" } },
        { id: "desc" },
      ];
    case "SEVERITY_ASC":
      return [
        { event: { severity: "asc" } },
        { event: { firstSignalCreatedAt: "desc" } },
        { id: "asc" },
      ];
    case "CREATED_DESC":
    default:
      return [{ event: { firstSignalCreatedAt: "desc" } }, { id: "desc" }];
  }
}

function eventsOrderBy(o?: EventOrderBy | null): Prisma.eventsOrderByWithRelationInput[] {
  switch (o) {
    case "LAST_SIGNAL_ASC":
      return [{ lastSignalCreatedAt: "asc" }, { id: "asc" }];
    case "CREATED_DESC":
      return [{ firstSignalCreatedAt: "desc" }, { id: "desc" }];
    case "CREATED_ASC":
      return [{ firstSignalCreatedAt: "asc" }, { id: "asc" }];
    case "SEVERITY_DESC":
      return [{ severity: "desc" }, { firstSignalCreatedAt: "desc" }, { id: "desc" }];
    case "SEVERITY_ASC":
      return [{ severity: "asc" }, { firstSignalCreatedAt: "desc" }, { id: "asc" }];
    case "LAST_SIGNAL_DESC":
    default:
      return [{ lastSignalCreatedAt: "desc" }, { id: "desc" }];
  }
}

function signalsOrderBy(o?: SignalOrderBy | null): Prisma.signalsOrderByWithRelationInput[] {
  switch (o) {
    case "PUBLISHED_ASC":
      return [{ publishedAt: "asc" }, { id: "asc" }];
    case "SEVERITY_DESC":
      return [{ severity: "desc" }, { publishedAt: "desc" }, { id: "desc" }];
    case "SEVERITY_ASC":
      return [{ severity: "asc" }, { publishedAt: "desc" }, { id: "asc" }];
    case "PUBLISHED_DESC":
    default:
      return [{ publishedAt: "desc" }, { id: "desc" }];
  }
}

// ─── Stats helpers ───────────────────────────────────────────────────────
type EntityKind = "signal" | "event" | "alert";
type StatsGroupBy = "none" | "type" | "severity" | "day" | "week" | "month";

interface EntityStatsInput extends CommonFilter {
  entity: EntityKind;
  groupBy?: StatsGroupBy | null;
}

/** Postgres date-trunc unit per groupBy. Lowercase per pg's `date_trunc`. */
function truncUnit(g: StatsGroupBy): "day" | "week" | "month" | null {
  if (g === "day" || g === "week" || g === "month") return g;
  return null;
}

/** ISO key formatter for date buckets. Postgres returns the truncated
 * timestamp at UTC; we render it as the appropriate calendar key. */
function formatBucketKey(d: Date, g: "day" | "week" | "month"): string {
  if (g === "day") return d.toISOString().slice(0, 10);
  if (g === "month") return d.toISOString().slice(0, 7);
  // ISO week — use Thursday-based week numbering (matches pg's date_trunc('week'))
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Resolve a CommonFilter to the table-name + where + timestamp column we
 * need for stats. Keeps the entity-specific decisions in one place. */
async function statsScope(
  prisma: Context["prisma"],
  input: EntityStatsInput,
): Promise<{
  table: string;
  whereSql: Prisma.Sql;
  tsCol: string;
  typeExpr: string; // SQL expression for the "type" group key
}> {
  // We translate our app-level filter into raw SQL for the groupBy paths
  // because Prisma's groupBy doesn't natively support array unnest or
  // date_trunc. The where clauses below mirror buildXxxWhere().
  const conds: Prisma.Sql[] = [];
  if (!input.includeDummy) conds.push(Prisma.sql`is_dummy = false`);
  if (input.severityMin != null) conds.push(Prisma.sql`severity >= ${input.severityMin}`);
  if (input.severityMax != null) conds.push(Prisma.sql`severity <= ${input.severityMax}`);
  if (input.from) conds.push(Prisma.sql`__TS__ >= ${new Date(input.from)}`);
  if (input.to) conds.push(Prisma.sql`__TS__ <= ${new Date(input.to)}`);
  if (input.eventTypes && input.eventTypes.length > 0 && input.entity !== "signal") {
    // event.types is a text[] — use the && (overlap) operator.
    conds.push(Prisma.sql`types && ${input.eventTypes}::text[]`);
  }
  if (input.locationId) {
    const ids = await getLocationIdsWithDescendants(prisma, input.locationId);
    if (ids.length > 0) {
      conds.push(
        Prisma.sql`(origin_id = ANY(${ids}::text[]) OR destination_id = ANY(${ids}::text[]) OR location_id = ANY(${ids}::text[]))`,
      );
    }
  }

  let table: string;
  let tsCol: string;
  let typeExpr: string;
  switch (input.entity) {
    case "signal":
      table = "signals";
      tsCol = "published_at";
      typeExpr = `(SELECT name FROM data_sources ds WHERE ds.id = signals.source_id)`;
      break;
    case "event":
      table = "events";
      tsCol = "first_signal_created_at";
      typeExpr = `unnest(types)`;
      break;
    case "alert":
      // Alerts are filtered via their event — join in the SQL for stats.
      table = "alerts JOIN events ON events.id = alerts.event_id";
      tsCol = "events.first_signal_created_at";
      typeExpr = `unnest(events.types)`;
      // alerts only has status; everything else is on `events`. Re-route the
      // AND clauses we built above to operate on events.* columns.
      // (We shadowed the column names — the WHERE template strings above
      // reference unqualified column names that exist on `events`, except
      // is_dummy which lives on events too. So the join works as-is.)
      break;
  }

  // Replace placeholder timestamp column.
  const where = conds.length > 0
    ? Prisma.sql`${conds.reduce((acc, c, i) => i === 0 ? c : Prisma.sql`${acc} AND ${c}`)}`
    : Prisma.empty;
  const whereSubbed = Prisma.raw(where.text.replaceAll("__TS__", tsCol));
  // Concat with values
  const finalWhere = conds.length > 0
    ? Prisma.sql`WHERE ${whereSubbed}`
    : Prisma.empty;

  return { table, whereSql: finalWhere, tsCol, typeExpr };
}

// ─── Resolvers ───────────────────────────────────────────────────────────

interface AlertsPageInput extends AlertsFilter {
  limit?: number | null;
  offset?: number | null;
  orderBy?: AlertOrderBy | null;
}

interface EventsPageInput extends EventsFilter {
  limit?: number | null;
  offset?: number | null;
  orderBy?: EventOrderBy | null;
}

interface SignalsPageInput extends SignalsFilter {
  limit?: number | null;
  offset?: number | null;
  orderBy?: SignalOrderBy | null;
}

export const paginationResolvers = {
  Query: {
    alertsPage: async (
      _parent: unknown,
      args: { input?: AlertsPageInput },
      context: Context,
    ) => {
      requireContentReader(context);
      const input = args.input ?? {};
      const where = await buildAlertsWhere(context.prisma, input);
      const limit = clampLimit(input.limit);
      const offset = clampOffset(input.offset);

      // Alerts wrap an event; the alerts feed renders the same nested
      // chain as the events feed (event title/description, locations,
      // signals' locations). Deep-include the whole event shape so
      // every field resolver hits the fast path.
      const eventInclude = deepEventInclude(context.locale);
      const alertsInclude = eventInclude
        ? { event: { include: eventInclude } }
        : undefined;

      const [items, totalCount] = await Promise.all([
        context.prisma.alerts.findMany({
          where,
          orderBy: alertsOrderBy(input.orderBy),
          take: limit,
          skip: offset,
          ...(alertsInclude ? { include: alertsInclude } : {}),
        }),
        context.prisma.alerts.count({ where }),
      ]);

      return {
        items,
        totalCount,
        hasMore: offset + items.length < totalCount,
      };
    },

    eventsPage: async (
      _parent: unknown,
      args: { input?: EventsPageInput },
      context: Context,
    ) => {
      requireContentReader(context);
      const input = args.input ?? {};
      const where = await buildEventsWhere(context.prisma, input);
      const limit = clampLimit(input.limit);
      const offset = clampOffset(input.offset);

      const eventsInclude = deepEventInclude(context.locale);

      const [items, totalCount] = await Promise.all([
        context.prisma.events.findMany({
          where,
          orderBy: eventsOrderBy(input.orderBy),
          take: limit,
          skip: offset,
          ...(eventsInclude ? { include: eventsInclude } : {}),
        }),
        context.prisma.events.count({ where }),
      ]);

      return {
        items,
        totalCount,
        hasMore: offset + items.length < totalCount,
      };
    },

    signalsPage: async (
      _parent: unknown,
      args: { input?: SignalsPageInput },
      context: Context,
    ) => {
      requireContentReader(context);
      const input = args.input ?? {};
      const where = await buildSignalsWhere(context.prisma, input);
      const limit = clampLimit(input.limit);
      const offset = clampOffset(input.offset);

      // Signals aren't translatable themselves but their nested
      // locations are. Fold those in so Location.name reads from the
      // pre-loaded translation row instead of the loader at scale.
      const signalsInclude = deepSignalInclude(context.locale);

      const [items, totalCount] = await Promise.all([
        context.prisma.signals.findMany({
          where,
          orderBy: signalsOrderBy(input.orderBy),
          take: limit,
          skip: offset,
          ...(signalsInclude ? { include: signalsInclude } : {}),
        }),
        context.prisma.signals.count({ where }),
      ]);

      return {
        items,
        totalCount,
        hasMore: offset + items.length < totalCount,
      };
    },

    entityStats: async (
      _parent: unknown,
      args: { input: EntityStatsInput },
      context: Context,
    ) => {
      requireContentReader(context);
      const input = args.input;
      const groupBy: StatsGroupBy = input.groupBy ?? "none";

      // Fast path for groupBy=none — reuse the Prisma `count()` machinery so
      // we don't have to round-trip through raw SQL.
      if (groupBy === "none") {
        let total: number;
        if (input.entity === "alert") {
          const where = await buildAlertsWhere(context.prisma, input as AlertsFilter);
          total = await context.prisma.alerts.count({ where });
        } else if (input.entity === "event") {
          const where = await buildEventsWhere(context.prisma, input as EventsFilter);
          total = await context.prisma.events.count({ where });
        } else {
          const where = await buildSignalsWhere(context.prisma, input as SignalsFilter);
          total = await context.prisma.signals.count({ where });
        }
        return { total, buckets: [] };
      }

      const { table, whereSql, tsCol, typeExpr } = await statsScope(context.prisma, input);

      // Build the SELECT key expression based on groupBy.
      let keyExpr: Prisma.Sql;
      const trunc = truncUnit(groupBy);
      if (groupBy === "type") {
        keyExpr = Prisma.raw(typeExpr);
      } else if (groupBy === "severity") {
        keyExpr = Prisma.raw(`severity::text`);
      } else if (trunc) {
        keyExpr = Prisma.raw(`date_trunc('${trunc}', ${tsCol})`);
      } else {
        keyExpr = Prisma.raw("NULL");
      }

      // Total is a simple COUNT(*) over the same WHERE.
      const tableSql = Prisma.raw(table);
      const totalRows = await context.prisma.$queryRaw<{ c: bigint }[]>(
        Prisma.sql`SELECT COUNT(*)::bigint AS c FROM ${tableSql} ${whereSql}`,
      );
      const total = Number(totalRows[0]?.c ?? 0n);

      // Buckets — note the GROUP BY repeats the key expression because
      // Postgres can't reference a SELECT alias in GROUP BY portably.
      const bucketRows = await context.prisma.$queryRaw<
        { key: string | Date | null; c: bigint }[]
      >(
        Prisma.sql`
          SELECT ${keyExpr} AS key, COUNT(*)::bigint AS c
          FROM ${tableSql}
          ${whereSql}
          GROUP BY ${keyExpr}
          ORDER BY c DESC
          LIMIT 200
        `,
      );

      const buckets = bucketRows.map((r) => {
        let key: string;
        if (r.key == null) {
          key = "(unknown)";
        } else if (r.key instanceof Date && trunc) {
          key = formatBucketKey(r.key, trunc);
        } else {
          key = String(r.key);
        }
        return { key, count: Number(r.c) };
      });

      return { total, buckets };
    },
  },
};
