import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { resolveTeamMembership } from "../utils/auth-guard.js";
import { createPointLocation, createRegionFromPoints, getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { buildEventLocationFilterForTeam } from "../utils/location-scope.js";
import { env } from "../utils/env.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import { alertNotification } from "../services/messaging/templates.js";

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
  rank?: number;
  signalIds?: string[];
}

export const eventResolvers = {
  Query: {
    events: async (_parent: unknown, args: { teamId?: string; includeDummy?: boolean }, context: Context) => {
      const user = requireAuth(context);
      const dummyFilter = args.includeDummy ? {} : { isDummy: false };
      if (!args.teamId) {
        if (user.role !== "admin") {
          throw new GraphQLError("teamId is required", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        return context.prisma.events.findMany({ where: dummyFilter });
      }
      await resolveTeamMembership(context.prisma, user.id, args.teamId, user.role);
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
      const user = requireAuth(context);
      const event = await context.prisma.events.findUnique({ where: { id: args.id } });
      if (!event) return null;
      if (user.role !== "admin") {
        // Events don't have a direct teamId; check via location-based team scope
        // For now, require admin access for single event lookups without team context
        const teamMemberships = await context.prisma.teamMembers.findMany({
          where: { userId: user.id },
          select: { teamId: true },
        });
        if (teamMemberships.length === 0) {
          throw new GraphQLError("No team membership found", {
            extensions: { code: "FORBIDDEN" },
          });
        }
        // Check if the event falls within any of the user's team scopes
        let accessible = false;
        for (const { teamId } of teamMemberships) {
          const filter = await buildEventLocationFilterForTeam(context.prisma, teamId);
          if (!filter) { accessible = true; break; } // global monitoring team
          const found = await context.prisma.events.findFirst({
            where: { id: args.id, ...filter },
          });
          if (found) { accessible = true; break; }
        }
        if (!accessible) {
          throw new GraphQLError("Event not accessible from your teams", {
            extensions: { code: "FORBIDDEN" },
          });
        }
      }
      return event;
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
          // Single lat/lng provided — create a point location
          const pointLoc = await createPointLocation(
            context.prisma, input.lat, input.lng, input.title ?? undefined,
          );
          locationId = pointLoc.id;
        } else if (input.signalIds.length > 0) {
          // No explicit location — gather point geometries from linked signals
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
              // Single point — reuse the signal's location directly
              locationId = [...locIds][0]!;
            } else if (locPoints.length > 1) {
              // Multiple points — create a convex hull region
              const region = await createRegionFromPoints(
                context.prisma, locPoints, input.title ?? undefined,
              );
              locationId = region.id;
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
          rank: input.rank,
        },
      });

      // Create signalEvents join entries
      if (input.signalIds.length > 0) {
        await context.prisma.signalEvents.createMany({
          data: input.signalIds.map((signalId) => ({
            signalId,
            eventId: event.id,
            collectedAt: new Date(),
          })),
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

      // Update signal links if provided
      if (input.signalIds !== undefined) {
        await context.prisma.signalEvents.deleteMany({ where: { eventId: id } });
        if (input.signalIds.length > 0) {
          await context.prisma.signalEvents.createMany({
            data: input.signalIds.map((signalId) => ({
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
          populationAffected: input.populationAffected !== undefined
            ? BigInt(input.populationAffected)
            : undefined,
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
          console.log("[escalateEvent] No locations on event — skipping subscriber notifications");
        } else if (event.types.length === 0) {
          console.log("[escalateEvent] No types on event — skipping subscriber notifications");
        }

        if (eventLocationIds.length > 0 && event.types.length > 0) {
          // Expand to include ancestor locations
          const allLocationIds = new Set(eventLocationIds);
          const locations = await context.prisma.locations.findMany({
            where: { id: { in: eventLocationIds } },
            select: { id: true, name: true, ancestorIds: true },
          });
          for (const loc of locations) {
            for (const aid of loc.ancestorIds) allLocationIds.add(aid);
          }

          const locationNames = locations.map((l) => l.name).join(", ");
          console.log(`[escalateEvent] Searching subscribers for types=${JSON.stringify(event.types)}, locations=[${locationNames}] (${allLocationIds.size} IDs including ancestors)`);

          const subscriptions = await context.prisma.userAlertSubscriptions.findMany({
            where: {
              active: true,
              frequency: "immediately",
              alertType: { in: event.types },
              locationId: { in: [...allLocationIds] },
            },
            select: { userId: true },
          });

          const uniqueUserIds = [...new Set(subscriptions.map((s) => s.userId))];
          console.log(`[escalateEvent] Found ${subscriptions.length} subscriptions → ${uniqueUserIds.length} unique users`);

          if (uniqueUserIds.length === 0) {
            console.log(`[escalateEvent] No subscribers found for locations=[${locationNames}] and types=${JSON.stringify(event.types)}`);
          }

          if (uniqueUserIds.length > 0) {
            const title = event.title ?? event.types[0] ?? "Alert";
            const alertUrl = `${env.FRONTEND_URL}/alerts/${alert.id}`;

            // 1. Populate userAlerts
            await context.prisma.userAlerts.createMany({
              data: uniqueUserIds.map((userId) => ({
                userId,
                alertId: alert.id,
              })),
              skipDuplicates: true,
            });
            console.log(`[escalateEvent] Created ${uniqueUserIds.length} userAlert records`);

            // 2. In-app notifications
            await context.prisma.notifications.createMany({
              data: uniqueUserIds.map((userId) => ({
                userId,
                message: `New alert: ${title}`,
                notificationType: "alert",
                actionUrl: `/alerts/${alert.id}`,
                actionText: "View Alert",
              })),
            });
            console.log(`[escalateEvent] Created ${uniqueUserIds.length} in-app notifications`);

            // 3. Email notifications (fire-and-forget)
            const emailUsers = await context.prisma.user.findMany({
              where: { id: { in: uniqueUserIds }, emailNotification: true },
              select: { name: true, email: true },
            });

            console.log(`[escalateEvent] ${emailUsers.length}/${uniqueUserIds.length} users have email notifications enabled`);

            if (emailUsers.length > 0) {
              const emailList = emailUsers.map((u) => u.email).join(", ");
              console.log(`[escalateEvent] Sending emails to: ${emailList}`);
              void (async () => {
                try {
                  const emailProvider = await getEmailProvider();
                  await emailProvider.sendBulk(
                    emailUsers.map((u) => {
                      const content = alertNotification(u.name, title, event.description, alertUrl);
                      return {
                        to: u.email,
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
              console.log("[escalateEvent] No users with email notifications enabled — skipping emails");
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
