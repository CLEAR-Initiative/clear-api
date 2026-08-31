import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { isPlatformAdmin, requireAuth, requireContentReader, requireRole, requireTeamContentWriter } from "../utils/auth-guard.js";
import { buildCrisisLocationFilterForUser } from "../utils/location-scope.js";
import { logActivity } from "../utils/activity-log.js";
import { enqueueTranslationDurable } from "../services/translation-queue.js";
import { DEFAULT_LOCALE, type Locale } from "../utils/locales.js";

/**
 * Build the Prisma `include` clause that folds the active-locale
 * translation row into a crisis query. Mirrors the `events` resolver
 * helper — see comment there for rationale. Returns undefined for the
 * canonical locale so the include is omitted entirely.
 */
function crisisTranslationsInclude(locale: Locale):
  | { translations: { where: { locale: string } } }
  | undefined {
  if (locale === DEFAULT_LOCALE) return undefined;
  return { translations: { where: { locale } } };
}

interface CreateCrisisFromEventsInput {
  title?: string;
  summary?: string;
  severity: number;
  locationId?: string;
  needs: Record<string, unknown>;
  eventIds: string[];
  /**
   * Team the crisis is being filed under. Used only for authorisation —
   * a `team_admin` or `field_coordinator` on this team is admitted even
   * without a global admin/analyst role. Ignored for platform-level
   * callers; the crisis itself has no team column.
   */
  teamId?: string;
}

interface UpdateCrisisPopulationInput {
  populationAffected?: string | null;
  populationInArea?: string | null;
  title?: string | null;
  summary?: string | null;
  /** LLM-generated forward scenarios. Shape:
   *  { most_likely, best_case, worst_case, description }. */
  scenarios?: Record<string, unknown> | null;
}

/**
 * Compute the sum of `populationAffected` across a list of events (BigInt-safe).
 * Returns null if every event has a null value.
 */
async function sumEventPopulationAffected(
  prisma: Context["prisma"],
  eventIds: string[],
): Promise<bigint | null> {
  if (eventIds.length === 0) return null;
  const events = await prisma.events.findMany({
    where: { id: { in: eventIds } },
    select: { populationAffected: true },
  });
  let total = 0n;
  let any = false;
  for (const e of events) {
    if (e.populationAffected !== null) {
      total += e.populationAffected;
      any = true;
    }
  }
  return any ? total : null;
}

// Crisis enrichment (populationInArea + narrative/scenarios/needs) is NOT
// dispatched from here. clear-api's only job is to flag the crisis as needing
// enrichment: `enrichmentStatus = PENDING` (set on create via the column
// default, and on every event-set change below). The clear-context-pipeline
// Dagster drain (`enrich_crises`) consumes `pendingCrises`, derives its own
// district ids + events, RAG-grounds the overview, writes the results back, and
// flips the crisis to ENRICHED via `markCrisisEnriched`. This replaces the
// legacy Celery `src.tasks.crisis.enrich_crisis` fire-and-forget (Celery→Dagster
// consolidation) — so no task dispatch and no district pre-computation here.

export const crisisResolvers = {
  Query: {
    crises: async (_parent: unknown, _args: unknown, context: Context) => {
      const user = requireContentReader(context);
      const tr = crisisTranslationsInclude(context.locale);
      // Pre-load nested events with their translations so /insights's
      // crises-list view doesn't fan out into N+1 Crisis.events queries
      // followed by per-event translation lookups. Each event's title
      // resolver hits the fast path off `parent.translations`.
      const eventInclude = tr
        ? { translations: { where: { locale: context.locale } } }
        : undefined;
      const include = tr
        ? {
            ...tr,
            eventCrises: {
              include: {
                event: eventInclude ? { include: eventInclude } : true,
              },
            },
          }
        : undefined;

      // Team-based location scoping. Global admins bypass. For everyone
      // else, restrict crises to the union of the caller's teams'
      // location bindings; a team with no bindings is treated as
      // open-to-all and disables the filter for the caller. See
      // buildCrisisLocationFilterForUser for the full semantics.
      const where = isPlatformAdmin(user)
        ? undefined
        : await buildCrisisLocationFilterForUser(context.prisma, user.id);

      return context.prisma.crises.findMany({
        ...(include ? { include } : {}),
        where,
      });
    },

    crisis: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      // Open to any approved caller (admin / analyst / viewer). The
      // team-based location scope on `crises` (plural) is a UX filter
      // for list views; crisis records themselves are platform-wide
      // content, so deep-link / by-id fetches do not check team
      // membership. Pending users are still blocked here — they have
      // no content access until an admin approves them.
      requireContentReader(context);
      const include = crisisTranslationsInclude(context.locale);
      const crisis = await context.prisma.crises.findUnique({
        where: { id: args.id },
        ...(include ? { include } : {}),
      });
      if (!crisis) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      return crisis;
    },

    // The Dagster enrichment drain: crises needing (re)enrichment
    // (enrichmentStatus = PENDING), oldest-first. Admin/pipeline only.
    pendingCrises: async (
      _parent: unknown,
      args: { first?: number | null },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const take = Math.min(Math.max(args.first ?? 100, 1), 500);
      return context.prisma.crises.findMany({
        where: { enrichmentStatus: "PENDING" },
        orderBy: { updatedAt: "asc" },
        take,
      });
    },
  },

  Mutation: {
    // Drain completion: the enrichment consumer marks a crisis ENRICHED once
    // narrative/scenarios/needs-analysis are current. Admin/pipeline only.
    // Idempotent. (setCrisisNeedsAnalysis also flips ENRICHED for the current
    // Celery path; this is the explicit signal for the Dagster consumer.)
    markCrisisEnriched: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const existing = await context.prisma.crises.findUnique({
        where: { id: args.id },
        select: { id: true },
      });
      if (!existing) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      return context.prisma.crises.update({
        where: { id: args.id },
        data: { enrichmentStatus: "ENRICHED" },
      });
    },

    /**
     * Create a new crisis from a list of event IDs.
     * Validates that all event IDs exist, then creates the crisis and
     * the event-crisis join records in a single transaction.
     */
    createCrisisFromEvents: async (
      _parent: unknown,
      args: { input: CreateCrisisFromEventsInput },
      context: Context,
    ) => {
      // Global admin/analyst may roll up any events into a crisis; a
      // team_admin / field_coordinator may do so when they supply the
      // teamId they're acting on behalf of. See `requireTeamContentWriter`.
      const { input } = args;
      await requireTeamContentWriter(context, input.teamId);

      if (input.eventIds.length === 0) {
        throw new GraphQLError("At least one event ID is required", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Validate all events exist
      const existingEvents = await context.prisma.events.findMany({
        where: { id: { in: input.eventIds } },
        select: { id: true },
      });
      if (existingEvents.length !== input.eventIds.length) {
        const found = new Set(existingEvents.map((e) => e.id));
        const missing = input.eventIds.filter((id) => !found.has(id));
        throw new GraphQLError(
          `Event(s) not found: ${missing.join(", ")}`,
          { extensions: { code: "NOT_FOUND" } },
        );
      }

      // Sum populationAffected from the events (sync, cheap)
      const populationAffected = await sumEventPopulationAffected(
        context.prisma,
        input.eventIds,
      );

      // Create crisis + join rows in a transaction
      const collectedAt = new Date();
      const crisis = await context.prisma.$transaction(async (tx) => {
        const created = await tx.crises.create({
          data: {
            title: input.title ?? undefined,
            summary: input.summary ?? undefined,
            severity: input.severity,
            locationId: input.locationId ?? undefined,
            needs: input.needs as InputJsonValue,
            populationAffected: populationAffected ?? undefined,
          },
        });

        await tx.eventCrises.createMany({
          data: input.eventIds.map((eventId) => ({
            crisisId: created.id,
            eventId,
            collectedAt,
          })),
        });

        return created;
      });

      // Enrichment (populationInArea + narrative/scenarios/needs) is handled
      // asynchronously by the Dagster `enrich_crises` drain: the crisis is born
      // enrichmentStatus=PENDING (column default) and the drain picks it up.
      // Any title/summary the caller supplied stays until the drain overwrites
      // it (the drain always regenerates the narrative).

      const actor = context.user;
      if (actor) {
        void logActivity(context.prisma, {
          userId: actor.id,
          action: "crisis.create",
          resourceType: "crisis",
          resourceId: crisis.id,
          metadata: {
            title: crisis.title,
            severity: crisis.severity,
            eventCount: input.eventIds.length,
            userProvidedTitle: Boolean(input.title),
          },
        });
      }

      return crisis;
    },

    /**
     * Add an event to an existing crisis.
     * Idempotent — returns the existing link if one already exists.
     */
    addEventToCrisis: async (
      _parent: unknown,
      args: { crisisId: string; eventId: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { crisisId, eventId } = args;

      // Validate both exist
      const [crisis, event] = await Promise.all([
        context.prisma.crises.findUnique({ where: { id: crisisId } }),
        context.prisma.events.findUnique({ where: { id: eventId } }),
      ]);

      if (!crisis) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (!event) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Check for existing link (idempotency)
      const existing = await context.prisma.eventCrises.findFirst({
        where: { crisisId, eventId },
      });
      if (existing) return existing;

      const link = await context.prisma.eventCrises.create({
        data: {
          crisisId,
          eventId,
          collectedAt: new Date(),
        },
      });

      // Recompute populations for the whole crisis
      const allLinks = await context.prisma.eventCrises.findMany({
        where: { crisisId },
        select: { eventId: true },
      });
      const allEventIds = allLinks.map((l) => l.eventId);

      const populationAffected = await sumEventPopulationAffected(
        context.prisma,
        allEventIds,
      );
      await context.prisma.crises.update({
        where: { id: crisisId },
        // Event set changed → enrichment is stale; flag it for the drain.
        data: { populationAffected, enrichmentStatus: "PENDING" },
      });

      // Event set changed → enrichment is stale. The PENDING flag above re-queues
      // the crisis for the Dagster `enrich_crises` drain, which regenerates the
      // narrative/scenarios/needs + populationInArea across the new event set.

      return link;
    },

    /**
     * Remove an event from a crisis and refresh the crisis state.
     * If the event being removed is the LAST one, deletes the crisis
     * entirely (FK cascades clean up the join row, feedback, and comments)
     * and returns null. Otherwise returns the updated crisis with a fresh
     * populationAffected and a regenerated narrative.
     */
    removeEventFromCrisis: async (
      _parent: unknown,
      args: { crisisId: string; eventId: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { crisisId, eventId } = args;

      const crisis = await context.prisma.crises.findUnique({
        where: { id: crisisId },
      });
      if (!crisis) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const link = await context.prisma.eventCrises.findFirst({
        where: { crisisId, eventId },
        select: { eventId: true, crisisId: true },
      });
      if (!link) {
        throw new GraphQLError("Event is not linked to this crisis", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const linkCount = await context.prisma.eventCrises.count({
        where: { crisisId },
      });

      // Last event — auto-delete the crisis rather than leave it in a
      // degenerate empty state. Cascades handle eventCrises / userFeedbacks
      // / userComments. Return null to signal the crisis no longer exists.
      if (linkCount <= 1) {
        await context.prisma.crises.delete({ where: { id: crisisId } });
        return null;
      }

      await context.prisma.eventCrises.deleteMany({
        where: { crisisId, eventId },
      });

      // Recompute populationAffected over the remaining events
      const remainingLinks = await context.prisma.eventCrises.findMany({
        where: { crisisId },
        select: { eventId: true },
      });
      const remainingEventIds = remainingLinks.map((l) => l.eventId);

      const populationAffected = await sumEventPopulationAffected(
        context.prisma,
        remainingEventIds,
      );
      const updated = await context.prisma.crises.update({
        where: { id: crisisId },
        // Event set changed → enrichment is stale; flag it for the drain.
        data: { populationAffected, enrichmentStatus: "PENDING" },
      });

      // Event set changed → enrichment is stale. The PENDING flag above re-queues
      // the crisis for the Dagster `enrich_crises` drain, which regenerates the
      // narrative/scenarios/needs + populationInArea over the remaining events.
      // Clients see the pre-update title/summary until the drain overwrites it.

      return updated;
    },

    /**
     * Append S3 keys to a crisis's attachments list. Idempotent — keys
     * already present in the list are skipped, so the UI can retry a
     * mutation without producing duplicates. Order is stable: new keys
     * append in the order received, after the existing list.
     */
    addCrisisAttachments: async (
      _parent: unknown,
      args: { id: string; keys: string[] },
      context: Context,
    ) => {
      requireAuth(context);

      const existing = await context.prisma.crises.findUnique({
        where: { id: args.id },
        select: { attachments: true },
      });
      if (!existing) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const current = existing.attachments ?? [];
      const seen = new Set(current);
      const next = [...current];
      for (const k of args.keys) {
        if (!k || seen.has(k)) continue;
        seen.add(k);
        next.push(k);
      }

      return context.prisma.crises.update({
        where: { id: args.id },
        data: { attachments: next },
      });
    },

    /**
     * Set the LLM-generated NRC SAF needs analysis inside the crisis's
     * `needs` JSONB. Uses a Postgres `||` merge so other keys on `needs`
     * are preserved (e.g. user-provided keys set at creation time stay
     * untouched). Admin/pipeline only.
     */
    setCrisisNeedsAnalysis: async (
      _parent: unknown,
      args: {
        id: string;
        generalSummary: string[];
        sector: Record<string, unknown>;
      },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { id, generalSummary, sector } = args;

      const existing = await context.prisma.crises.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // JSONB merge: builds an object with the two new keys and unions it
      // into `needs`. The Postgres `||` operator preserves any keys
      // already present on `needs` (e.g. sector breakdowns the user set at
      // creation time), only overwriting `generalSummary` and `sector`.
      // `generalSummary` is a JSON array of bullet strings — stringify and
      // cast to jsonb so the array round-trips losslessly through SQL.
      const generalSummaryJson = JSON.stringify(generalSummary);
      const sectorJson = JSON.stringify(sector);
      // The SAF needs analysis is the terminal enrichment writeback, so clear
      // the drain marker (ENRICHED) in the same statement. The explicit
      // markCrisisEnriched mutation covers the Dagster consumer's own signal.
      await context.prisma.$executeRaw`
        UPDATE "crises"
        SET "needs" = COALESCE("needs", '{}'::jsonb)
          || jsonb_build_object(
            'generalSummary', ${generalSummaryJson}::jsonb,
            'sector', ${sectorJson}::jsonb
          ),
          "enrichment_status" = 'ENRICHED'
        WHERE "id" = ${id}
      `;

      return context.prisma.crises.findUniqueOrThrow({ where: { id } });
    },

    /**
     * Remove an S3 key from a crisis's attachments list. Does not delete
     * the underlying S3 object — that's a separate cleanup concern. Returns
     * the updated crisis even if the key wasn't in the list (idempotent).
     */
    removeCrisisAttachment: async (
      _parent: unknown,
      args: { id: string; key: string },
      context: Context,
    ) => {
      requireAuth(context);

      const existing = await context.prisma.crises.findUnique({
        where: { id: args.id },
        select: { attachments: true },
      });
      if (!existing) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const current: string[] = existing.attachments ?? [];
      const next = current.filter((k: string) => k !== args.key);

      return context.prisma.crises.update({
        where: { id: args.id },
        data: { attachments: next },
      });
    },

    /**
     * Edit a crisis's title. Any authenticated user — users routinely
     * rename auto-generated titles to fit their reporting style.
     *
     * Audit log (transactional with the title update): a row is appended
     * to `userFeedbacks` with `rating=0` (sentinel for system/audit
     * entries — real user feedback uses 1-5) and `text` carrying the
     * old → new diff prefixed with `[title-edit]`. The presence of any
     * such row also functions as the title lock: `updateCrisisPopulation`
     * checks for it and skips its own title update if any exists, so an
     * event add/remove can't clobber the user's wording.
     */
    updateCrisisTitle: async (
      _parent: unknown,
      args: { id: string; title: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const { id, title } = args;

      const existing = await context.prisma.crises.findUnique({
        where: { id },
        select: { id: true, title: true },
      });
      if (!existing) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const auditText =
        `[title-edit] ${existing.title ?? "(empty)"} → ${title || "(empty)"}`;

      const [updated] = await context.prisma.$transaction([
        context.prisma.crises.update({
          where: { id },
          data: { title },
        }),
        context.prisma.userFeedbacks.create({
          data: {
            userId: user.id,
            crisisId: id,
            rating: 0, // sentinel: system audit entry, not actual user feedback
            text: auditText,
          },
        }),
      ]);

      return updated;
    },

    /**
     * Edit a crisis's description (the human-facing prose). The crisis's
     * `summary` column stores JSON of the form `{ description, tldr }` —
     * we parse the existing value, swap the description, and re-serialise
     * so the LLM-generated `tldr` bullets stay intact across user edits.
     *
     * Legacy crises whose summary is plain string (pre-JSON refactor) get
     * promoted to the new shape on first edit: `{ description, tldr: [] }`.
     */
    updateCrisisDescription: async (
      _parent: unknown,
      args: { id: string; description: string },
      context: Context,
    ) => {
      requireAuth(context);
      const { id, description } = args;

      const existing = await context.prisma.crises.findUnique({
        where: { id },
        select: { id: true, summary: true },
      });
      if (!existing) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Preserve tldr (and any future structured siblings) when present.
      let nextSummary: Record<string, unknown> = { description, tldr: [] };
      if (existing.summary) {
        try {
          const parsed: unknown = JSON.parse(existing.summary);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            nextSummary = { ...(parsed as Record<string, unknown>), description };
          }
        } catch {
          // Legacy plain-string summary — falls through to the default
          // structured shape with the user's new description.
        }
      }

      return context.prisma.crises.update({
        where: { id },
        data: { summary: JSON.stringify(nextSummary) },
      });
    },

    /**
     * Delete a crisis. Any authenticated user can call this — crises are
     * lightweight aggregations users curate, not a sensitive admin object.
     * Relies on the FK cascade rules to clean up eventCrises join rows,
     * user feedback, and user comments.
     */
    deleteCrisis: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      // Destructive operation with cascade (eventCrises, userComments,
      // userFeedbacks, translations all drop with the crisis). Restricted
      // to global admins.
      requireRole(context, ["admin"]);

      const existing = await context.prisma.crises.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.crises.delete({ where: { id: args.id } });
      return true;
    },

    updateCrisisPopulation: async (
      _parent: unknown,
      args: { id: string; input: UpdateCrisisPopulationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { id, input } = args;

      const existing = await context.prisma.crises.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Prisma nullable JSON fields require the typed-null sentinel rather
      // than a plain `null` in update inputs — `Prisma.DbNull` writes SQL
      // NULL to the column (vs `Prisma.JsonNull` which writes the JSON
      // literal `null`). We want SQL NULL since "no scenarios generated
      // yet" is the field's natural absent state.
      const data: {
        populationAffected?: bigint | null;
        populationInArea?: bigint | null;
        title?: string | null;
        summary?: string | null;
        scenarios?: InputJsonValue | typeof Prisma.DbNull;
      } = {};
      if (input.populationAffected !== undefined) {
        data.populationAffected = input.populationAffected === null
          ? null
          : BigInt(input.populationAffected);
      }
      if (input.populationInArea !== undefined) {
        data.populationInArea = input.populationInArea === null
          ? null
          : BigInt(input.populationInArea);
      }
      // Title lock: if the user has manually edited the title (via
      // `updateCrisisTitle`), the enrichment pipeline must NOT overwrite
      // it on subsequent event add/remove cycles. We silently drop the
      // title from the update set rather than throwing — the pipeline
      // shouldn't have to know about the lock, and refusing the whole
      // mutation would also block populationInArea / summary / scenarios
      // updates that are still useful.
      //
      // Source of truth: a `userFeedbacks` row with rating=0 and a
      // `[title-edit]` text prefix is written by `updateCrisisTitle` for
      // each manual edit. The presence of any such row locks the title.
      if (input.title !== undefined) {
        const titleEditAudit = await context.prisma.userFeedbacks.findFirst({
          where: {
            crisisId: id,
            rating: 0,
            text: { startsWith: "[title-edit]" },
          },
          select: { id: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        });
        if (titleEditAudit) {
          console.log(
            `[updateCrisisPopulation] Skipping title update for crisis=${id} ` +
              `— manually edited by user at ${titleEditAudit.createdAt.toISOString()}`,
          );
        } else {
          data.title = input.title;
        }
      }
      if (input.summary !== undefined) data.summary = input.summary;
      if (input.scenarios !== undefined) {
        data.scenarios = input.scenarios === null
          ? Prisma.DbNull
          : (input.scenarios as InputJsonValue);
      }

      return context.prisma.crises.update({ where: { id }, data });
    },
  },

  Crisis: {
    // Localized overlays. Prefers `parent.translations` when the caller
    // fetched the crisis via prisma with the include from
    // `crisisTranslationsInclude` — that's the path used by
    // Query.crisis / Query.crises now. Falls back to the per-request
    // translationLoader for entry points that didn't include
    // translations (e.g. Crisis nested inside other resolvers). At
    // locale === "en" both paths short-circuit to the canonical column.
    //
    // For nested JSON fields (scenarios, needs) the translated blob
    // mirrors the canonical shape, so the resolver returns the whole
    // translated blob (matching the existing canonical contract).
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
          enqueueTranslationDurable(context.prisma, "crisis", parent.id, context.locale);
        }
        return parent.title;
      }
      const tr = await context.translationLoader.load("crisis", parent.id);
      const localized = tr?.title;
      return typeof localized === "string" ? localized : parent.title;
    },
    summary: async (
      parent: {
        id: string;
        summary: string | null;
        translations?: Array<{ data: unknown }>;
      },
      _args: unknown,
      context: Context,
    ) => {
      if (context.locale === DEFAULT_LOCALE) return parent.summary;
      if (parent.translations !== undefined) {
        const data = parent.translations[0]?.data as
          | { summary?: unknown }
          | undefined;
        const localized = data?.summary;
        if (typeof localized === "string") return localized;
        if (parent.translations.length === 0) {
          enqueueTranslationDurable(context.prisma, "crisis", parent.id, context.locale);
        }
        return parent.summary;
      }
      const tr = await context.translationLoader.load("crisis", parent.id);
      const localized = tr?.summary;
      return typeof localized === "string" ? localized : parent.summary;
    },
    scenarios: async (
      parent: {
        id: string;
        scenarios: unknown;
        translations?: Array<{ data: unknown }>;
      },
      _args: unknown,
      context: Context,
    ) => {
      if (context.locale === DEFAULT_LOCALE) return parent.scenarios;
      if (parent.translations !== undefined) {
        const data = parent.translations[0]?.data as
          | { scenarios?: unknown }
          | undefined;
        const localized = data?.scenarios;
        if (localized != null) return localized;
        if (parent.translations.length === 0) {
          enqueueTranslationDurable(context.prisma, "crisis", parent.id, context.locale);
        }
        return parent.scenarios;
      }
      const tr = await context.translationLoader.load("crisis", parent.id);
      const localized = tr?.scenarios;
      return localized != null ? localized : parent.scenarios;
    },
    needs: async (
      parent: {
        id: string;
        needs: unknown;
        translations?: Array<{ data: unknown }>;
      },
      _args: unknown,
      context: Context,
    ) => {
      if (context.locale === DEFAULT_LOCALE) return parent.needs;
      if (parent.translations !== undefined) {
        const data = parent.translations[0]?.data as
          | { needs?: unknown }
          | undefined;
        const localized = data?.needs;
        if (localized != null) return localized;
        if (parent.translations.length === 0) {
          enqueueTranslationDurable(context.prisma, "crisis", parent.id, context.locale);
        }
        return parent.needs;
      }
      const tr = await context.translationLoader.load("crisis", parent.id);
      const localized = tr?.needs;
      return localized != null ? localized : parent.needs;
    },
    generalLocation: (
      parent: { locationId: string | null },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (!parent.locationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.locationId } });
    },
    populationAffected: (parent: { populationAffected: bigint | null }) => {
      return parent.populationAffected?.toString() ?? null;
    },
    populationInArea: (parent: { populationInArea: bigint | null }) => {
      return parent.populationInArea?.toString() ?? null;
    },
    events: (
      parent: { id: string; eventCrises?: Array<{ event: unknown }> },
      _args: unknown,
      { prisma }: Context,
    ) => {
      // Fast path: Query.crises deep-includes eventCrises.event so
      // /insights's crises-list view skips the N+1 fetch and reads
      // events (with pre-loaded translations) directly off the parent.
      if (parent.eventCrises) {
        return parent.eventCrises.map((l) => l.event);
      }
      return prisma.eventCrises
        .findMany({
          where: { crisisId: parent.id },
          include: { event: true },
        })
        .then((links) => links.map((l) => l.event));
    },
    /**
     * Visibility rules:
     *   - admin / analyst → every feedback row on this crisis
     *   - viewer          → only the caller's own feedback (so a dev can
     *                       see their own engagement history without
     *                       exposing other users' commentary)
     *   - otherwise       → empty (defensive — the parent crisis query
     *                       already enforces `requireContentReader`)
     */
    feedbacks: (parent: { id: string }, _args: unknown, ctx: Context) => {
      const role = ctx.user?.role ?? "";
      if (isPlatformAdmin(ctx.user) || role === "analyst") {
        return ctx.prisma.userFeedbacks.findMany({ where: { crisisId: parent.id } });
      }
      if (role === "viewer" && ctx.user) {
        return ctx.prisma.userFeedbacks.findMany({
          where: { crisisId: parent.id, userId: ctx.user.id },
        });
      }
      return [];
    },
    comments: (parent: { id: string }, _args: unknown, ctx: Context) => {
      const role = ctx.user?.role ?? "";
      if (isPlatformAdmin(ctx.user) || role === "analyst") {
        return ctx.prisma.userComments.findMany({ where: { crisisId: parent.id } });
      }
      if (role === "viewer" && ctx.user) {
        return ctx.prisma.userComments.findMany({
          where: { crisisId: parent.id, userId: ctx.user.id },
        });
      }
      return [];
    },
    // Convert S3 keys to presigned URLs at read time. External URLs
    // (http/https) are passed through unchanged. Mirrors signals.media.
    attachments: async (parent: { attachments: string[] | null | undefined }) => {
      if (!parent.attachments || parent.attachments.length === 0) return [];
      const { getPresignedUrl } = await import("../services/s3.js");
      return Promise.all(
        parent.attachments.map((entry) =>
          entry.startsWith("http") ? entry : getPresignedUrl(entry),
        ),
      );
    },
  },

  EventCrisis: {
    crisis: (
      parent: { crisisId: string },
      _args: unknown,
      { prisma }: Context,
    ) => {
      return prisma.crises.findUnique({ where: { id: parent.crisisId } });
    },
    event: (
      parent: { eventId: string },
      _args: unknown,
      { prisma }: Context,
    ) => {
      return prisma.events.findUnique({ where: { id: parent.eventId } });
    },
  },
};
