import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { isPlatformAdmin, requireContentReader, requireRole, requireTeamContentWriter } from "../utils/auth-guard.js";
import { logActivity } from "../utils/activity-log.js";
import { createPointLocation, getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { buildLocationFilterForTeam } from "../utils/location-scope.js";
import { uploadFileToS3 } from "../services/s3.js";
import { sendCeleryTask } from "../services/celery.js";

const TRUSTED_SOURCE_NAMES = new Set(["field_officer", "partner", "government"]);

interface FileUpload {
  filename: string;
  mimetype: string;
  encoding: string;
  createReadStream: () => NodeJS.ReadableStream;
}

interface CreateManualSignalInput {
  sourceId: string;
  title: string;
  description: string;
  severity?: number;
  url?: string;
  /** Media URLs (pre-uploaded via /api/upload endpoint) */
  mediaUrls?: string[];
  /** Media files (direct upload via graphql-upload) */
  media?: Promise<FileUpload>[];
  locationId?: string;
  originId?: string;
  destinationId?: string;
  lat?: number;
  lng?: number;
  metadata?: Record<string, unknown>;
  /**
   * Team the signal is filed under. Used only for authorisation — when
   * present, a caller with `team_admin` or `field_coordinator` on this team
   * is admitted even without a global `admin`/`analyst` role. The signal
   * itself has no team column; team scope is derived from location.
   */
  teamId?: string;
}

interface CreateSignalInput {
  sourceId: string;
  /** Stable upstream id for idempotent ingestion. If set and a row with
   *  the same (sourceId, externalId) exists, the existing row is returned. */
  externalId?: string;
  rawData: Record<string, unknown>;
  /** Pointer to the raw payload blob in the S3 data lake (Dagster ingest). */
  rawS3Key?: string;
  publishedAt: string;
  collectedAt?: string;
  url?: string;
  title?: string;
  description?: string;
  severity?: number;
  /** Reported casualties (e.g. ACLED `fatalities`, parsed from Dataminr text). */
  casualties?: number;
  /** Media URLs from source (stored directly, no S3 upload) */
  media?: string[];
  originId?: string;
  destinationId?: string;
  locationId?: string;
  lat?: number;
  lng?: number;
  /** Output of clear-pipeline's text-based geoparser, stored verbatim. */
  geoparsedData?: Record<string, unknown>;
  /** Optional human-readable name for the L4 point that gets created
   *  when lat/lng are supplied but locationId is not. The pipeline fills
   *  this with the geoparser's top candidate suffixed " (unresolved)"
   *  when Nominatim missed. Falls back to a coord-based label when
   *  omitted; the signal `title` is never used here so headline-style
   *  paragraphs don't leak into the locations table. */
  pointName?: string;
}

/** In-place content revision for an existing signal (e.g. IDMC IDU
 *  revisions). `contentHash` gates the write — a no-op retry (unchanged
 *  data resent) leaves the row and lastRevisedAt untouched. */
interface UpdateSignalContentInput {
  id: string;
  contentHash: string;
  rawData: Record<string, unknown>;
  url?: string;
  title?: string;
  description?: string;
  severity?: number;
  casualties?: number;
  originId?: string;
  destinationId?: string;
  locationId?: string;
  lat?: number;
  lng?: number;
  geoparsedData?: Record<string, unknown>;
  pointName?: string;
}

/** Resolve a signal's locationId: pass through an explicit id, or fall back
 *  to creating an L4 point location from lat/lng. Shared by createSignal and
 *  updateSignalContent so a revision resolves location the same way a
 *  fresh signal does. */
async function resolveLocationId(
  context: Context,
  { locationId, lat, lng, pointName }: {
    locationId?: string;
    lat?: number;
    lng?: number;
    pointName?: string;
  },
): Promise<string | undefined> {
  if (locationId) return locationId;
  if (lat != null && lng != null) {
    const pointLoc = await createPointLocation(context.prisma, lat, lng, pointName ?? undefined);
    return pointLoc.id;
  }
  return undefined;
}

// ─── Signal Location challenge (Location trust v1, clear-mvp #314) ───────────
// v1 has exactly one open state; a resubmit updates the single open row per
// signal (enforced by @@unique([signalId, status])).
const OPEN_CHALLENGE_STATUS = "consideration";
const CHALLENGE_NOTE_MAX = 2000;
const CHALLENGE_NAME_MAX = 500;

interface SubmitLocationChallengeInput {
  signalId: string;
  note?: string | null;
  proposedLng?: number | null;
  proposedLat?: number | null;
  proposedName?: string | null;
}

/** Trim to null (empty → null); reject when over `max`. */
function trimChallengeText(value: string | null | undefined, max: number, field: string): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new GraphQLError(`${field} must be at most ${max} characters.`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return trimmed;
}

export const signalResolvers = {
  Query: {
    signals: async (_parent: unknown, args: { teamId?: string; includeDummy?: boolean }, context: Context) => {
      requireContentReader(context);
      const dummyFilter = args.includeDummy ? {} : { isDummy: false };
      // No teamId: any authenticated user gets the global feed.
      if (!args.teamId) {
        return context.prisma.signals.findMany({ where: dummyFilter });
      }
      // teamId provided: apply that team's location filter without
      // requiring the caller to be a member — the team scope is just a
      // view filter now, not an access gate.
      const filter = await buildLocationFilterForTeam(context.prisma, args.teamId);
      return context.prisma.signals.findMany({ where: { ...filter, ...dummyFilter } });
    },
    signalsByLocation: async (_parent: unknown, args: { locationId: string }, context: Context) => {
      requireContentReader(context);
      const locationIds = await getLocationIdsWithDescendants(context.prisma, args.locationId);
      return context.prisma.signals.findMany({
        where: {
          OR: [
            { originId: { in: locationIds } },
            { destinationId: { in: locationIds } },
            { locationId: { in: locationIds } },
          ],
        },
      });
    },
    signal: async (_parent: unknown, args: { id: string }, context: Context) => {
      requireContentReader(context);
      const { DEFAULT_LOCALE } = await import("../utils/locales.js");
      const tr =
        context.locale === DEFAULT_LOCALE
          ? undefined
          : { translations: { where: { locale: context.locale } } };
      const locInclude = tr ? { include: tr } : undefined;
      // Preload signal-detail's outer chain: source, 3 signal-locations
      // (with translations at non-canonical locale), and signalEvents +
      // related events (with translations). Event.signals fires its
      // own per-event findMany for each related event — that's
      // acceptable at the observed related-event counts (~10) but
      // can't be folded any deeper without blowing the SSH tunnel's
      // effective throughput (a previous version included the events'
      // own signalEvents.signal chain and wedged at 2+ minutes).
      const include = {
        source: true,
        signalEvents: {
          include: {
            event: locInclude ? { include: tr } : true,
          },
          take: 25,
        },
        ...(locInclude
          ? {
              generalLocation: locInclude,
              originLocation: locInclude,
              destinationLocation: locInclude,
            }
          : {}),
      };
      return context.prisma.signals.findUnique({
        where: { id: args.id },
        include,
      });
    },

    signalLocationChallenges: async (
      _parent: unknown,
      args: { teamId?: string | null; status?: string | null },
      context: Context,
    ) => {
      requireContentReader(context);
      const status = args.status ?? OPEN_CHALLENGE_STATUS;
      // Team scope is a view filter (like `signals`): challenges whose Signal
      // falls within the team's locations. No teamId = global feed; a team with
      // no scope locations = no filter.
      const signalFilter = args.teamId
        ? await buildLocationFilterForTeam(context.prisma, args.teamId)
        : undefined;
      return context.prisma.signalLocationChallenges.findMany({
        where: { status, ...(signalFilter ? { signal: signalFilter } : {}) },
        orderBy: { createdAt: "desc" },
      });
    },

    // The Dagster event-driven drain: signals awaiting downstream processing
    // (status = NEW), oldest-first so ingestion order is preserved. `source`
    // filters by DataSource name (e.g. "dataminr") so a per-source consumer can
    // drain just its own backlog. Admin/pipeline only.
    pendingSignals: async (
      _parent: unknown,
      args: { first?: number | null; source?: string | null },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const take = Math.min(Math.max(args.first ?? 100, 1), 500);
      return context.prisma.signals.findMany({
        where: {
          status: "NEW",
          isDummy: false,
          ...(args.source ? { source: { name: args.source } } : {}),
        },
        orderBy: { publishedAt: "asc" },
        take,
      });
    },
  },
  Mutation: {
    createSignal: async (
      _parent: unknown,
      args: { input: CreateSignalInput },
      context: Context,
    ) => {
      // Admin/analyst only. The pipeline integrations (Dataminr, ACLED,
      // GDACS) authenticate as a system admin user via API key. Viewers
      // are read-only in the new role model and pending users are
      // blocked from every content path.
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      const dataSource = await context.prisma.dataSources.findUnique({
        where: { id: input.sourceId },
      });
      if (!dataSource) {
        throw new GraphQLError("DataSource not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Idempotent ingestion: if an externalId is provided and a signal
      // already exists for (sourceId, externalId), return it as-is. This
      // makes the mutation safe to retry and prevents duplicate rows when
      // the upstream poller's Redis seen-set has expired.
      if (input.externalId) {
        const existing = await context.prisma.signals.findUnique({
          where: {
            sourceId_externalId: {
              sourceId: input.sourceId,
              externalId: input.externalId,
            },
          },
        });
        if (existing) return existing;
      }

      // Resolve lat/lng to a level-4 point location if no explicit
      // locationId is provided. We pass `pointName` not `title` —
      // signal titles for some sources (e.g. Dataminr) are full alert
      // paragraphs, so using them as the L4 name pollutes the locations
      // table with non-place strings.
      const locationId = await resolveLocationId(context, {
        locationId: input.locationId,
        lat: input.lat,
        lng: input.lng,
        pointName: input.pointName,
      });

      try {
        return await context.prisma.signals.create({
          data: {
            sourceId: input.sourceId,
            externalId: input.externalId,
            rawData: input.rawData as InputJsonValue,
            rawS3Key: input.rawS3Key,
            publishedAt: new Date(input.publishedAt),
            collectedAt: input.collectedAt ? new Date(input.collectedAt) : new Date(),
            url: input.url,
            title: input.title,
            description: input.description,
            severity: input.severity,
            casualties: input.casualties,
            media: input.media ?? [],
            originId: input.originId,
            destinationId: input.destinationId,
            locationId,
            geoparsedData: input.geoparsedData as InputJsonValue | undefined,
          },
        });
      } catch (err: unknown) {
        // P2002 = unique constraint violation. If it fires for
        // (sourceId, externalId), a concurrent writer got there first -
        // fall back to returning that row so the caller is idempotent.
        if (
          typeof err === "object" && err !== null && "code" in err &&
          (err as { code: unknown }).code === "P2002" && input.externalId
        ) {
          const existing = await context.prisma.signals.findUnique({
            where: {
              sourceId_externalId: {
                sourceId: input.sourceId,
                externalId: input.externalId,
              },
            },
          });
          if (existing) return existing;
        }
        throw err;
      }
    },

    // Drain completion: the Dagster downstream marks signals PROCESSED (or
    // FAILED on terminal failure) once classify→group→alert has run. Returns
    // the number of rows updated. Admin/pipeline only. Idempotent — re-marking
    // an already-processed signal is a harmless no-op update.
    markSignalsProcessed: async (
      _parent: unknown,
      args: { ids: string[]; status?: "NEW" | "PROCESSED" | "FAILED" | null },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      if (args.ids.length === 0) return 0;
      // The SDL exposes the full SignalStatus enum, but NEW would produce a
      // contradictory row (status=NEW alongside a processedAt). Reject it.
      if (args.status === "NEW") {
        throw new GraphQLError(
          "markSignalsProcessed only accepts PROCESSED or FAILED",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      const status = args.status ?? "PROCESSED";
      const result = await context.prisma.signals.updateMany({
        where: { id: { in: args.ids } },
        data: { status, processedAt: new Date() },
      });
      return result.count;
    },

    createManualSignal: async (
      _parent: unknown,
      args: { input: CreateManualSignalInput },
      context: Context,
    ) => {
      // Authorisation model — see `requireTeamContentWriter`:
      // global admin/analyst may file for any location; a `team_admin` or
      // `field_coordinator` may file when they supply the `teamId` they're
      // acting on behalf of. `team_member` and everyone else are rejected.
      // Downstream guards (TRUSTED_SOURCE_NAMES on dataSource, severity >= 4,
      // staleness gate) still keep low-severity / stale manual entries from
      // fanning out as alerts.
      const { input } = args;
      const { user } = await requireTeamContentWriter(context, input.teamId);

      // Validate source exists and is a trusted type
      const dataSource = await context.prisma.dataSources.findUnique({
        where: { id: input.sourceId },
      });
      if (!dataSource) {
        throw new GraphQLError("DataSource not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (!TRUSTED_SOURCE_NAMES.has(dataSource.name)) {
        throw new GraphQLError(
          `Manual signals must use a trusted source (${[...TRUSTED_SOURCE_NAMES].join(", ")}), got "${dataSource.name}"`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      // Resolve location from lat/lng if needed. Title is omitted on
      // purpose — see createSignal above for rationale. Manual signals
      // fall back to a coord-based L4 label unless the caller starts
      // passing a curated `pointName` later.
      let locationId = input.locationId;
      if (!locationId && input.lat != null && input.lng != null) {
        const pointLoc = await createPointLocation(
          context.prisma, input.lat, input.lng,
        );
        locationId = pointLoc.id;
      }

      // Collect media URLs - from pre-uploaded URLs and/or direct file uploads
      const media: string[] = [...(input.mediaUrls ?? [])];
      if (input.media && input.media.length > 0) {
        const files = await Promise.all(input.media);
        for (const file of files) {
          const url = await uploadFileToS3(file.createReadStream(), file.filename, file.mimetype);
          media.push(url);
        }
      }

      // Create the signal
      const signal = await context.prisma.signals.create({
        data: {
          sourceId: input.sourceId,
          rawData: {
            manual: true,
            createdBy: user.id,
            title: input.title,
            description: input.description,
            ...(input.metadata && { metadata: input.metadata }),
          } as InputJsonValue,
          publishedAt: new Date(),
          collectedAt: new Date(),
          url: input.url,
          title: input.title,
          description: input.description,
          severity: input.severity,
          media,
          originId: input.originId,
          destinationId: input.destinationId,
          locationId,
        },
      });

      // Queue pipeline processing via Celery (fire-and-forget).
      // signal_published_at lets the pipeline apply the staleness gate; we
      // pass the row's actual publishedAt so the kwarg is consistent if the
      // schema later allows backdated publishedAt values.
      void sendCeleryTask("src.tasks.process.process_manual_signal", {
        signal_id: signal.id,
        source_type: dataSource.name,
        title: input.title,
        description: input.description,
        severity: input.severity ?? null,
        user_id: user.id,
        signal_published_at: signal.publishedAt.toISOString(),
      }).catch((err) => {
        console.error("[createManualSignal] Failed to queue pipeline task:", err);
      });

      void logActivity(context.prisma, {
        userId: user.id,
        action: "signal.create_manual",
        resourceType: "signal",
        resourceId: signal.id,
        metadata: {
          title: input.title,
          sourceName: dataSource.name,
          severity: input.severity ?? null,
        },
      });

      return signal;
    },

    updateSignalSeverity: async (
      _parent: unknown,
      args: { id: string; severity: number },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);

      const existing = await context.prisma.signals.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Signal not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.signals.update({
        where: { id: args.id },
        data: { severity: args.severity },
      });
    },

    updateSignalGeoparsedData: async (
      _parent: unknown,
      args: { id: string; geoparsedData: Record<string, unknown> },
      context: Context,
    ) => {
      // Admin/pipeline only — invoked by the manual-signal processing task
      // after running the geoparser on the freshly created signal.
      requireRole(context, ["admin"]);

      const existing = await context.prisma.signals.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Signal not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.signals.update({
        where: { id: args.id },
        data: { geoparsedData: args.geoparsedData as InputJsonValue },
      });
    },

    updateSignalLocation: async (
      _parent: unknown,
      args: { id: string; locationId: string },
      context: Context,
    ) => {
      // Admin/pipeline only — invoked by the manual-signal processing task
      // after the geoparser resolves a candidate and we've promoted it to
      // an L4 via findOrCreateLandmarkL4. Sets `generalLocation` (the
      // `location_id` column); leaves origin/destination alone.
      requireRole(context, ["admin"]);

      const existing = await context.prisma.signals.findUnique({
        where: { id: args.id },
        select: { id: true },
      });
      if (!existing) {
        throw new GraphQLError("Signal not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Validate the target location exists so a bad locationId returns a
      // clear error instead of a Prisma FK-violation stacktrace.
      const targetLoc = await context.prisma.locations.findUnique({
        where: { id: args.locationId },
        select: { id: true },
      });
      if (!targetLoc) {
        throw new GraphQLError("Location not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.signals.update({
        where: { id: args.id },
        data: { locationId: args.locationId },
      });
    },

    updateSignalContent: async (
      _parent: unknown,
      args: { input: UpdateSignalContentInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const { input } = args;

      const existing = await context.prisma.signals.findUnique({
        where: { id: input.id },
      });
      if (!existing) {
        throw new GraphQLError("Signal not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Not a revision — either an unchanged retry (e.g. the pipeline's Redis
      // seen-set re-sending after its TTL expired) or the row was never
      // revised at all. Leave it untouched, including lastRevisedAt.
      if (existing.contentHash === input.contentHash) {
        return existing;
      }

      const locationId = await resolveLocationId(context, {
        locationId: input.locationId,
        lat: input.lat,
        lng: input.lng,
        pointName: input.pointName,
      });

      return context.prisma.signals.update({
        where: { id: input.id },
        data: {
          rawData: input.rawData as InputJsonValue,
          url: input.url,
          title: input.title,
          description: input.description,
          severity: input.severity,
          casualties: input.casualties,
          originId: input.originId,
          destinationId: input.destinationId,
          locationId,
          geoparsedData: input.geoparsedData as InputJsonValue | undefined,
          contentHash: input.contentHash,
          lastRevisedAt: new Date(),
        },
      });
    },

    deleteSignal: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.signals.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Signal not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.signals.delete({ where: { id: args.id } });
      return true;
    },

    submitSignalLocationChallenge: async (
      _parent: unknown,
      { input }: { input: SubmitLocationChallengeInput },
      context: Context,
    ) => {
      const user = requireContentReader(context);

      // 1. Signal must exist. (Team scope is a view filter, not a hard access
      //    gate here — mirrors the signal(id) / signals queries.)
      const signal = await context.prisma.signals.findUnique({
        where: { id: input.signalId },
        select: { id: true },
      });
      if (!signal) {
        throw new GraphQLError(`Signal ${input.signalId} not found.`, {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // 2. Point pair: both set or both omitted; validate ranges when present.
      const hasLng = input.proposedLng != null;
      const hasLat = input.proposedLat != null;
      if (hasLng !== hasLat) {
        throw new GraphQLError(
          "proposedLng and proposedLat must both be set, or both omitted.",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      const proposedLng = hasLng ? input.proposedLng! : null;
      const proposedLat = hasLat ? input.proposedLat! : null;
      if (proposedLng !== null && (!Number.isFinite(proposedLng) || proposedLng < -180 || proposedLng > 180)) {
        throw new GraphQLError("proposedLng must be a finite number in [-180, 180].", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      if (proposedLat !== null && (!Number.isFinite(proposedLat) || proposedLat < -90 || proposedLat > 90)) {
        throw new GraphQLError("proposedLat must be a finite number in [-90, 90].", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const note = trimChallengeText(input.note, CHALLENGE_NOTE_MAX, "note");
      const proposedName = trimChallengeText(input.proposedName, CHALLENGE_NAME_MAX, "proposedName");

      // 3. Upsert the single open row for this signal — resubmit replaces it.
      //    Never writes into the signal's own origin/destination/location.
      const fields = { createdBy: user.id, note, proposedLng, proposedLat, proposedName };
      return context.prisma.signalLocationChallenges.upsert({
        where: { signalId_status: { signalId: input.signalId, status: OPEN_CHALLENGE_STATUS } },
        create: { signalId: input.signalId, status: OPEN_CHALLENGE_STATUS, ...fields },
        update: fields,
      });
    },
  },
  Signal: {
    source: (
      parent: { sourceId: string; source?: unknown },
      _args: unknown,
      { prisma }: Context,
    ) => {
      // Fast path: when the signal was preloaded via Event.signals' deep
      // include (`include.signal.source: true`), the source object is
      // already on the parent. Returning it directly avoids re-running
      // `dataSources.findUnique` per signal — the N+1 that wedged event
      // detail at high signal counts.
      if (parent.source !== undefined) return parent.source;
      return prisma.dataSources.findUnique({ where: { id: parent.sourceId } });
    },
    // Fast path on all three: when the signal was preloaded via a deep
    // Prisma include (e.g. eventsPage's
    // `include.signalEvents.signal.{general,origin,destination}Location`),
    // the location object — translations included — is already on the
    // parent and we just return it. Without this every signal in the
    // list fan-out fires another findUnique per location, exactly the
    // N+1 the include was meant to collapse.
    originLocation: (
      parent: { originId: string | null; originLocation?: unknown },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (parent.originLocation !== undefined) return parent.originLocation;
      if (!parent.originId) return null;
      return prisma.locations.findUnique({ where: { id: parent.originId } });
    },
    destinationLocation: (
      parent: { destinationId: string | null; destinationLocation?: unknown },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (parent.destinationLocation !== undefined) return parent.destinationLocation;
      if (!parent.destinationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.destinationId } });
    },
    generalLocation: (
      parent: { locationId: string | null; generalLocation?: unknown },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (parent.generalLocation !== undefined) return parent.generalLocation;
      if (!parent.locationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.locationId } });
    },
    events: (
      parent: { id: string; signalEvents?: Array<{ event: unknown }> },
      _args: unknown,
      { prisma }: Context,
    ) => {
      // Fast path: Query.signal deep-includes signalEvents.event so the
      // signal-detail page can skip this fetch and hit the Event.title
      // fast path directly off the pre-loaded translations.
      if (parent.signalEvents) {
        return parent.signalEvents.map((l) => l.event);
      }
      // Hard cap. Each event returned here will fan out one
      // Event.signals findMany per event from the GraphQL detail
      // query — without a cap, a signal linked to hundreds of events
      // wedges the response through the SSH tunnel (~50ms × N tunnel
      // round-trips). 25 is plenty for the UI's related-events panel.
      return prisma.signalEvents.findMany({
        where: { signalId: parent.id },
        include: { event: true },
        take: 25,
      }).then((links) => links.map((l) => l.event));
    },
    // Same visibility split as Crisis/Event feedbacks/comments: admin/
    // analyst see all; viewer sees only their own; everyone else empty.
    feedbacks: (parent: { id: string }, _args: unknown, ctx: Context) => {
      const role = ctx.user?.role ?? "";
      if (isPlatformAdmin(ctx.user) || role === "analyst") {
        return ctx.prisma.userFeedbacks.findMany({ where: { signalId: parent.id } });
      }
      if (role === "viewer" && ctx.user) {
        return ctx.prisma.userFeedbacks.findMany({
          where: { signalId: parent.id, userId: ctx.user.id },
        });
      }
      return [];
    },
    comments: (parent: { id: string }, _args: unknown, ctx: Context) => {
      const role = ctx.user?.role ?? "";
      if (isPlatformAdmin(ctx.user) || role === "analyst") {
        return ctx.prisma.userComments.findMany({ where: { signalId: parent.id } });
      }
      if (role === "viewer" && ctx.user) {
        return ctx.prisma.userComments.findMany({
          where: { signalId: parent.id, userId: ctx.user.id },
        });
      }
      return [];
    },
    // Admin/pipeline only — the raw upstream payload can carry
    // source-internal fields (e.g. createManualSignal's `createdBy` user
    // id) never meant for a general viewer. Soft-null rather than throwing,
    // matching feedbacks/comments above: an unauthorized caller selecting
    // this field must not null out the whole parent Signal/Event subtree.
    rawData: (parent: { rawData?: unknown }, _args: unknown, ctx: Context) => {
      const role = ctx.user?.role ?? "";
      if (isPlatformAdmin(ctx.user) || role === "pipeline") {
        return parent.rawData ?? null;
      }
      return null;
    },
    // Convert S3 keys to presigned URLs at read time.
    // External URLs (http/https) are passed through unchanged.
    media: async (parent: { media: string[] }) => {
      if (!parent.media || parent.media.length === 0) return [];
      const { getPresignedUrl } = await import("../services/s3.js");
      return Promise.all(
        parent.media.map((entry) =>
          entry.startsWith("http") ? entry : getPresignedUrl(entry),
        ),
      );
    },
    locationChallenge: (
      parent: { id: string; locationChallenge?: unknown },
      _args: unknown,
      { prisma }: Context,
    ) => {
      // Fast path when preloaded via a deep include; else load the open row.
      if (parent.locationChallenge !== undefined) return parent.locationChallenge;
      return prisma.signalLocationChallenges.findFirst({
        where: { signalId: parent.id, status: OPEN_CHALLENGE_STATUS },
      });
    },
  },
  SignalLocationChallenge: {
    hasProposedPoint: (parent: { proposedLng: number | null; proposedLat: number | null }) =>
      parent.proposedLng != null && parent.proposedLat != null,
  },
};
