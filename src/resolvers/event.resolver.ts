import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { logActivity } from "../utils/activity-log.js";
import { createPointLocation, resolvePointsToCommonAncestor, getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { buildEventLocationFilterForTeam } from "../utils/location-scope.js";
import { env } from "../utils/env.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import { alertNotification } from "../services/messaging/templates.js";
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

interface CreateEventInput {
  title?: string;
  description?: string;
  descriptionSignals?: Record<string, unknown>;
  validFrom: string;
  validTo: string;
  firstSignalCreatedAt: string;
  lastSignalCreatedAt: string;
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
}

interface UpdateEventInput {
  title?: string;
  description?: string;
  descriptionSignals?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
  firstSignalCreatedAt?: string;
  lastSignalCreatedAt?: string;
  originId?: string;
  destinationId?: string;
  locationId?: string;
  types?: string[];
  severity?: number;
  populationAffected?: string;
  populationDisplaced?: string;
  casualties?: number;
  rank?: number;
  signalIds?: string[];
}

export const eventResolvers = {
  Query: {
    events: async (_parent: unknown, args: { teamId?: string; includeDummy?: boolean }, context: Context) => {
      requireAuth(context);
      const dummyFilter = args.includeDummy ? {} : { isDummy: false };
      // No teamId: any authenticated user gets the global feed.
      if (!args.teamId) {
        return context.prisma.events.findMany({ where: dummyFilter });
      }
      // teamId provided: apply that team's location filter as a view filter
      // (no membership check -  see signals resolver for rationale).
      const filter = await buildEventLocationFilterForTeam(context.prisma, args.teamId);
      return context.prisma.events.findMany({ where: { ...filter, ...dummyFilter } });
    },
    eventsByLocation: async (_parent: unknown, args: { locationId: string }, context: Context) => {
      requireAuth(context);
      const locationIds = await getLocationIdsWithDescendants(context.prisma, args.locationId);
      return context.prisma.events.findMany({
        where: {
          OR: [
            { originId: { in: locationIds } },
            { destinationId: { in: locationIds } },
            { locationId: { in: locationIds } },
          ],
        },
      });
    },
    event: async (_parent: unknown, args: { id: string }, context: Context) => {
      requireAuth(context);
      return context.prisma.events.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createEvent: async (
      _parent: unknown,
      args: { input: CreateEventInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      // Resolve location for the event
      let locationId = input.locationId;
      const originId = input.originId;
      const destinationId = input.destinationId;

      if (!locationId && !originId && !destinationId) {
        if (input.lat != null && input.lng != null) {
          // Single lat/lng provided -  create a point location
          const pointLoc = await createPointLocation(
            context.prisma, input.lat, input.lng, input.title ?? undefined,
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

          if (locIds.size > 0) {
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

            if (locPoints.length === 1) {
              // Single point — reuse the signal's location directly.
              locationId = [...locIds][0]!;
            } else if (locPoints.length > 1) {
              // Multiple points — attribute the event to the deepest admin
              // polygon containing them all (A2 if same district, A1 if same
              // state, A0 otherwise). Keeps `locations` purely administrative
              // instead of accreting a convex-hull region row per event.
              const ancestor = await resolvePointsToCommonAncestor(
                context.prisma, locPoints,
              );
              if (ancestor) locationId = ancestor.id;
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
          validTo: new Date(input.validTo),
          firstSignalCreatedAt: new Date(input.firstSignalCreatedAt),
          lastSignalCreatedAt: new Date(input.lastSignalCreatedAt),
          originId,
          destinationId,
          locationId,
          types: input.types,
          severity: input.severity,
          populationAffected: input.populationAffected
            ? BigInt(input.populationAffected)
            : undefined,
          populationDisplaced: input.populationDisplaced
            ? BigInt(input.populationDisplaced)
            : undefined,
          casualties: input.casualties,
          rank: input.rank,
        },
      });

      // Create signalEvents join entries (dedupe the input array first so
      // the same signalId repeated in the request doesn't create duplicate links).
      if (input.signalIds.length > 0) {
        const uniqueSignalIds = [...new Set(input.signalIds)];
        await context.prisma.signalEvents.createMany({
          data: uniqueSignalIds.map((signalId) => ({
            signalId,
            eventId: event.id,
            collectedAt: new Date(),
          })),
        });
      }

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

    updateEvent: async (
      _parent: unknown,
      args: { id: string; input: UpdateEventInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { id, input } = args;

      const existing = await context.prisma.events.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Update signal links -  ADDITIVE + IDEMPOTENT semantics. Passing
      // signalIds appends them to the event; already-linked signals are
      // skipped. Callers that want to fully replace links should delete
      // them explicitly (no current use case).
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

      return context.prisma.events.update({
        where: { id },
        data: {
          title: input.title ?? undefined,
          description: input.description ?? undefined,
          description_signals: input.descriptionSignals
            ? (input.descriptionSignals as InputJsonValue)
            : undefined,
          validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
          validTo: input.validTo ? new Date(input.validTo) : undefined,
          firstSignalCreatedAt: input.firstSignalCreatedAt
            ? new Date(input.firstSignalCreatedAt)
            : undefined,
          lastSignalCreatedAt: input.lastSignalCreatedAt
            ? new Date(input.lastSignalCreatedAt)
            : undefined,
          originId: input.originId,
          destinationId: input.destinationId,
          locationId: input.locationId,
          types: input.types ?? undefined,
          severity: input.severity ?? undefined,
          populationAffected: input.populationAffected !== undefined
            ? BigInt(input.populationAffected)
            : undefined,
          populationDisplaced: input.populationDisplaced !== undefined
            ? BigInt(input.populationDisplaced)
            : undefined,
          casualties: input.casualties ?? undefined,
          rank: input.rank ?? undefined,
        },
      });
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
      args: { eventId: string; userId: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);

      const event = await context.prisma.events.findUnique({
        where: { id: args.eventId },
      });
      if (!event) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
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

          const eventSeverity = event.severity ?? 1;
          const subscriptions = await context.prisma.userAlertSubscriptions.findMany({
            where: {
              active: true,
              frequency: "immediately",
              alertType: { in: event.types },
              locationId: { in: [...allLocationIds] },
              minSeverity: { lte: eventSeverity },
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
            const alertUrl = `${env.FRONTEND_URL}/event/${event.id}`;
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
                actionUrl: `/event/${event.id}`,
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
    // Localized overlay — falls through to the canonical column when no
    // translation exists for the active locale (including locale === "en",
    // where the loader is a no-op).
    title: async (
      parent: { id: string; title: string | null },
      _args: unknown,
      { translationLoader }: Context,
    ) => {
      const tr = await translationLoader.load("event", parent.id);
      const localized = tr?.title;
      return typeof localized === "string" ? localized : parent.title;
    },
    description: async (
      parent: { id: string; description: string | null },
      _args: unknown,
      { translationLoader }: Context,
    ) => {
      const tr = await translationLoader.load("event", parent.id);
      const localized = tr?.description;
      return typeof localized === "string" ? localized : parent.description;
    },
    signals: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.signalEvents.findMany({
        where: { eventId: parent.id },
        include: { signal: true },
      }).then((links) => links.map((l) => l.signal));
    },
    originLocation: (parent: { originId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.originId) return null;
      return prisma.locations.findUnique({ where: { id: parent.originId } });
    },
    destinationLocation: (parent: { destinationId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.destinationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.destinationId } });
    },
    generalLocation: (parent: { locationId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.locationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.locationId } });
    },
    alerts: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alerts.findMany({ where: { eventId: parent.id } });
    },
    feedbacks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userFeedbacks.findMany({ where: { eventId: parent.id } });
    },
    comments: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userComments.findMany({ where: { eventId: parent.id } });
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
