import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { AlertStatus } from "../generated/prisma/client.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { buildEventLocationFilterForTeam } from "../utils/location-scope.js";
import { env } from "../utils/env.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import { alertNotification } from "../services/messaging/templates.js";

interface CreateAlertInput {
  eventId: string;
  status?: AlertStatus;
}

interface UpdateAlertInput {
  status?: AlertStatus;
}

export const alertResolvers = {
  Query: {
    alerts: async (_parent: unknown, args: { status?: AlertStatus; teamId?: string; includeDummy?: boolean }, context: Context) => {
      requireAuth(context);
      const eventDummyFilter = args.includeDummy ? {} : { isDummy: false };
      // No teamId: any authenticated user gets the global feed.
      if (!args.teamId) {
        return context.prisma.alerts.findMany({
          where: {
            ...(args.status ? { status: args.status } : {}),
            event: eventDummyFilter,
          },
        });
      }
      // teamId provided: apply that team's location filter as a view filter
      // (no membership check — see signals resolver for rationale).
      const eventLocationFilter = await buildEventLocationFilterForTeam(context.prisma, args.teamId);
      return context.prisma.alerts.findMany({
        where: {
          ...(args.status ? { status: args.status } : {}),
          event: { ...eventDummyFilter, ...(eventLocationFilter ?? {}) },
        },
      });
    },
    alertsByLocation: async (
      _parent: unknown,
      args: { locationId: string; status?: AlertStatus },
      context: Context,
    ) => {
      requireAuth(context);
      const locationIds = await getLocationIdsWithDescendants(context.prisma, args.locationId);
      return context.prisma.alerts.findMany({
        where: {
          ...(args.status ? { status: args.status } : {}),
          event: {
            OR: [
              { originId: { in: locationIds } },
              { destinationId: { in: locationIds } },
              { locationId: { in: locationIds } },
            ],
          },
        },
      });
    },
    alert: async (_parent: unknown, args: { id: string }, context: Context) => {
      requireAuth(context);
      return context.prisma.alerts.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createAlert: async (
      _parent: unknown,
      args: { input: CreateAlertInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      // Verify the event exists
      const event = await context.prisma.events.findUnique({
        where: { id: input.eventId },
      });
      if (!event) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Idempotent creation: if an alert already exists for this event,
      // return it (updating the status if the caller requested a different
      // one). Prevents duplicate alerts when the pipeline retries or when
      // the same event is re-escalated.
      const existingAlert = await context.prisma.alerts.findFirst({
        where: { eventId: input.eventId },
        orderBy: { id: "asc" }, // deterministic: earliest wins
      });
      const alert = existingAlert
        ? (input.status && input.status !== existingAlert.status
            ? await context.prisma.alerts.update({
                where: { id: existingAlert.id },
                data: { status: input.status },
              })
            : existingAlert)
        : await context.prisma.alerts.create({
            data: {
              eventId: input.eventId,
              status: input.status ?? "draft",
            },
          });

      // Skip the notification fan-out when the alert already existed —
      // subscribers were notified on the original create, we don't want
      // to spam them on every retry.
      if (existingAlert) return alert;

      // Fan out notifications to immediate subscribers
      const eventLocationIds = [
        event.originId,
        event.destinationId,
        event.locationId,
      ].filter((id): id is string => id !== null);

      console.log(`[createAlert] Event ${event.id}: types=${JSON.stringify(event.types)}, locationIds=${JSON.stringify(eventLocationIds)}`);

      if (eventLocationIds.length === 0) {
        console.log("[createAlert] No locations on event — skipping subscriber notifications");
      } else if (event.types.length === 0) {
        console.log("[createAlert] No types on event — skipping subscriber notifications");
      }

      if (eventLocationIds.length > 0 && event.types.length > 0) {
        // Expand locations to include ancestors so country-level subscriptions
        // match district-level alerts
        const allLocationIds = new Set(eventLocationIds);
        const locations = await context.prisma.locations.findMany({
          where: { id: { in: eventLocationIds } },
          select: { id: true, name: true, ancestorIds: true },
        });
        for (const loc of locations) {
          for (const aid of loc.ancestorIds) allLocationIds.add(aid);
        }

        const locationNames = locations.map((l) => l.name).join(", ");
        console.log(`[createAlert] Searching subscribers for types=${JSON.stringify(event.types)}, locations=[${locationNames}] (${allLocationIds.size} IDs including ancestors)`);

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
        console.log(`[createAlert] Found ${subscriptions.length} subscriptions → ${uniqueUserIds.length} unique users`);

        if (uniqueUserIds.length === 0) {
          console.log(`[createAlert] No subscribers found for locations=[${locationNames}] and types=${JSON.stringify(event.types)}`);
        }

        if (uniqueUserIds.length > 0) {
          const title = event.title ?? event.types[0] ?? "Alert";
          const alertUrl = `${env.FRONTEND_URL}/event/${event.id}`;

          // 1. Populate userAlerts join table
          await context.prisma.userAlerts.createMany({
            data: uniqueUserIds.map((userId) => ({
              userId,
              alertId: alert.id,
            })),
            skipDuplicates: true,
          });
          console.log(`[createAlert] Created ${uniqueUserIds.length} userAlert records`);

          // 2. Create in-app notifications
          await context.prisma.notifications.createMany({
            data: uniqueUserIds.map((userId) => ({
              userId,
              message: `New alert: ${title}`,
              notificationType: "alert",
              actionUrl: `/event/${event.id}`,
              actionText: "View Alert",
            })),
          });
          console.log(`[createAlert] Created ${uniqueUserIds.length} in-app notifications`);

          // 3. Send email notifications (fire-and-forget)
          const emailUsers = await context.prisma.user.findMany({
            where: { id: { in: uniqueUserIds }, emailNotification: true },
            select: { name: true, email: true },
          });

          console.log(`[createAlert] ${emailUsers.length}/${uniqueUserIds.length} users have email notifications enabled`);

          if (emailUsers.length > 0) {
            const emailList = emailUsers.map((u) => u.email).join(", ");
            console.log(`[createAlert] Sending emails to: ${emailList}`);
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
                console.log(`[createAlert] Email sent successfully to ${emailUsers.length} users`);
              } catch (err) {
                console.error("[createAlert] Failed to send alert emails:", err);
              }
            })();
          } else {
            console.log("[createAlert] No users with email notifications enabled — skipping emails");
          }
        }
      }

      return alert;
    },

    updateAlert: async (
      _parent: unknown,
      args: { id: string; input: UpdateAlertInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { id, input } = args;

      const existing = await context.prisma.alerts.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.alerts.update({
        where: { id },
        data: {
          status: input.status ?? undefined,
        },
      });
    },

    deleteAlert: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.alerts.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.alerts.delete({ where: { id: args.id } });
      return true;
    },

    /**
     * Bulk-archive alerts whose event.lastSignalCreatedAt is older than
     * `olderThanDays` (default 14). One SQL UPDATE via Prisma updateMany.
     * Only targets non-archived alerts so repeat runs are idempotent.
     */
    archiveStaleAlerts: async (
      _parent: unknown,
      args: { olderThanDays?: number },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const days = args.olderThanDays ?? 14;
      if (!Number.isFinite(days) || days < 1) {
        throw new GraphQLError("olderThanDays must be a positive integer", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const result = await context.prisma.alerts.updateMany({
        where: {
          status: { not: "archived" },
          event: { lastSignalCreatedAt: { lt: cutoff } },
        },
        data: { status: "archived" },
      });

      return { alertsArchived: result.count };
    },
  },
  Alert: {
    event: (parent: { eventId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.events.findUnique({ where: { id: parent.eventId } });
    },
    userAlerts: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userAlerts.findMany({ where: { alertId: parent.id } });
    },
  },
  UserAlert: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    alert: (parent: { alertId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alerts.findUnique({ where: { id: parent.alertId } });
    },
  },
};
