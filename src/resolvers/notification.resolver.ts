import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { NotificationStatus, PrismaClient } from "../generated/prisma/client.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { env } from "../utils/env.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import { alertNotification, alertDigest } from "../services/messaging/templates.js";

interface CreateNotificationInput {
  userId: string;
  message: string;
  notificationType: string;
  actionUrl?: string;
  actionText?: string;
}

interface CreateBulkNotificationsInput {
  userIds: string[];
  message: string;
  notificationType: string;
  actionUrl?: string;
  actionText?: string;
}

interface AlertNotifyInput {
  alertId: string;
}

interface AlertDigestInput {
  alertIds: string[];
  frequency: "daily" | "weekly" | "monthly";
}

/**
 * Find all subscriber user IDs for a given alert based on its event's
 * types and locations, filtered by frequency.
 */
async function findSubscribers(
  prisma: PrismaClient,
  eventTypes: string[],
  locationIds: string[],
  frequency: "immediately" | "daily" | "weekly" | "monthly",
): Promise<string[]> {
  if (eventTypes.length === 0 || locationIds.length === 0) return [];

  // Expand locations to include ancestors (subscriptions at country level
  // should match alerts at district level)
  const allLocationIds = new Set(locationIds);
  const locations = await prisma.locations.findMany({
    where: { id: { in: locationIds } },
    select: { ancestorIds: true },
  });
  for (const loc of locations) {
    for (const ancestorId of loc.ancestorIds) {
      allLocationIds.add(ancestorId);
    }
  }

  const subscriptions = await prisma.userAlertSubscriptions.findMany({
    where: {
      active: true,
      frequency,
      alertType: { in: eventTypes },
      locationId: { in: [...allLocationIds] },
    },
    select: { userId: true },
  });

  return [...new Set(subscriptions.map((s) => s.userId))];
}

export const notificationResolvers = {
  Query: {
    notifications: (_parent: unknown, args: { status?: NotificationStatus }, context: Context) => {
      const user = requireAuth(context);
      return context.prisma.notifications.findMany({
        where: {
          userId: user.id,
          ...(args.status ? { status: args.status } : {}),
        },
        orderBy: { createdAt: "desc" },
      });
    },
    notification: (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireAuth(context);
      return context.prisma.notifications.findFirst({
        where: { id: args.id, userId: user.id },
      });
    },
  },
  Mutation: {
    createNotification: async (
      _parent: unknown,
      args: { input: CreateNotificationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { input } = args;

      return context.prisma.notifications.create({
        data: {
          userId: input.userId,
          message: input.message,
          notificationType: input.notificationType,
          actionUrl: input.actionUrl,
          actionText: input.actionText,
        },
      });
    },
    createBulkNotifications: async (
      _parent: unknown,
      args: { input: CreateBulkNotificationsInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      const result = await context.prisma.notifications.createMany({
        data: input.userIds.map((userId) => ({
          userId,
          message: input.message,
          notificationType: input.notificationType,
          actionUrl: input.actionUrl,
          actionText: input.actionText,
        })),
      });

      return result.count;
    },
    notifyAlertSubscribers: async (
      _parent: unknown,
      args: { input: AlertNotifyInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);

      const alert = await context.prisma.alerts.findUnique({
        where: { id: args.input.alertId },
        include: { event: true },
      });
      if (!alert) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const event = alert.event;
      const eventLocationIds = [event.originId, event.destinationId, event.locationId].filter(
        (id): id is string => id !== null,
      );

      const userIds = await findSubscribers(
        context.prisma,
        event.types,
        eventLocationIds,
        "immediately",
      );

      if (userIds.length === 0) return 0;

      const title = event.title ?? event.types[0] ?? "Alert";
      const alertUrl = `${env.FRONTEND_URL}/event/${event.id}`;

      // 1. Populate userAlerts join table
      await context.prisma.userAlerts.createMany({
        data: userIds.map((userId) => ({
          userId,
          alertId: alert.id,
        })),
        skipDuplicates: true,
      });

      // 2. Create in-app notifications
      const result = await context.prisma.notifications.createMany({
        data: userIds.map((userId) => ({
          userId,
          message: `New alert: ${title}`,
          notificationType: "alert",
          actionUrl: `/event/${event.id}`,
          actionText: "View Alert",
        })),
      });

      // 3. Send email notifications to users who have email notifications enabled
      const emailUsers = await context.prisma.user.findMany({
        where: { id: { in: userIds }, emailNotification: true },
        select: { id: true, name: true, email: true },
      });

      if (emailUsers.length > 0) {
        const emailProvider = await getEmailProvider();
        const emails = emailUsers.map((u) => {
          const content = alertNotification(u.name, title, event.description, alertUrl);
          return {
            to: u.email,
            subject: content.subject,
            textBody: content.textBody,
            htmlBody: content.htmlBody,
          };
        });

        // Fire-and-forget — don't block the response on email delivery
        void emailProvider.sendBulk(emails).catch((err) => {
          console.error("[NOTIFY] Failed to send alert emails:", err);
        });
      }

      return result.count;
    },
    notifyAlertDigest: async (
      _parent: unknown,
      args: { input: AlertDigestInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { alertIds, frequency } = args.input;

      if (!["daily", "weekly", "monthly"].includes(frequency)) {
        throw new GraphQLError("Frequency must be daily, weekly, or monthly", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const alerts = await context.prisma.alerts.findMany({
        where: { id: { in: alertIds } },
        include: { event: true },
      });

      if (alerts.length === 0) return 0;

      // Pre-compute the expanded location set (including ancestors) for each alert
      const alertLocationSets: Map<string, Set<string>> = new Map();
      const allTypes = new Set<string>();
      const allExpandedLocationIds = new Set<string>();

      for (const alert of alerts) {
        for (const t of alert.event.types) allTypes.add(t);

        const directIds = [
          alert.event.originId,
          alert.event.destinationId,
          alert.event.locationId,
        ].filter((id): id is string => id !== null);

        const expanded = new Set(directIds);
        const locations = await context.prisma.locations.findMany({
          where: { id: { in: directIds } },
          select: { ancestorIds: true },
        });
        for (const loc of locations) {
          for (const aid of loc.ancestorIds) expanded.add(aid);
        }
        alertLocationSets.set(alert.id, expanded);
        for (const lid of expanded) allExpandedLocationIds.add(lid);
      }

      if (allTypes.size === 0 || allExpandedLocationIds.size === 0) return 0;

      // Fetch only subscriptions that match ANY of the alert types AND locations
      const subscriptions = await context.prisma.userAlertSubscriptions.findMany({
        where: {
          active: true,
          frequency,
          alertType: { in: [...allTypes] },
          locationId: { in: [...allExpandedLocationIds] },
        },
        select: { userId: true, alertType: true, locationId: true },
      });

      if (subscriptions.length === 0) return 0;

      // For each user, find which alerts match their subscriptions
      // userAlertMap: userId → Set<alertId>
      const userAlertMap = new Map<string, Set<string>>();

      for (const sub of subscriptions) {
        for (const alert of alerts) {
          const typesMatch = alert.event.types.includes(sub.alertType);
          const locationSet = alertLocationSets.get(alert.id);
          const locationMatch = locationSet?.has(sub.locationId) ?? false;

          if (typesMatch && locationMatch) {
            let set = userAlertMap.get(sub.userId);
            if (!set) {
              set = new Set();
              userAlertMap.set(sub.userId, set);
            }
            set.add(alert.id);
          }
        }
      }

      if (userAlertMap.size === 0) return 0;

      const frequencyLabel = frequency.charAt(0).toUpperCase() + frequency.slice(1);
      const dashboardUrl = `${env.FRONTEND_URL}/detection`;

      // 1. Populate userAlerts join table for each user's matched alerts
      const userAlertData: Array<{ userId: string; alertId: string }> = [];
      for (const [userId, matchedAlertIds] of userAlertMap) {
        for (const alertId of matchedAlertIds) {
          userAlertData.push({ userId, alertId });
        }
      }
      await context.prisma.userAlerts.createMany({
        data: userAlertData,
        skipDuplicates: true,
      });

      // 2. Create in-app notifications per user
      const notificationData: Array<{
        userId: string;
        message: string;
        notificationType: string;
        actionUrl: string;
        actionText: string;
      }> = [];

      for (const [userId, matchedAlertIds] of userAlertMap) {
        const count = matchedAlertIds.size;
        const titles = alerts
          .filter((a) => matchedAlertIds.has(a.id))
          .map((a) => a.event.title ?? a.event.types[0] ?? "Alert")
          .slice(0, 3);
        const preview = titles.join(", ") + (count > 3 ? ` +${count - 3} more` : "");

        notificationData.push({
          userId,
          message: `${frequencyLabel} digest (${count}): ${preview}`,
          notificationType: "alert_digest",
          actionUrl: "/detection",
          actionText: "View Alerts",
        });
      }

      const result = await context.prisma.notifications.createMany({
        data: notificationData,
      });

      // 3. Send digest emails to users who have email notifications enabled
      const allUserIds = [...userAlertMap.keys()];
      const emailUsers = await context.prisma.user.findMany({
        where: { id: { in: allUserIds }, emailNotification: true },
        select: { id: true, name: true, email: true },
      });

      if (emailUsers.length > 0) {
        const emailProvider = await getEmailProvider();
        const emails = emailUsers.map((u) => {
          const matchedIds = userAlertMap.get(u.id)!;
          const userAlerts = alerts
            .filter((a) => matchedIds.has(a.id))
            .map((a) => ({
              title: a.event.title ?? a.event.types[0] ?? "Alert",
              description: a.event.description,
              url: `${env.FRONTEND_URL}/event/${a.event.id}`,
            }));

          const content = alertDigest(u.name, frequency, userAlerts, dashboardUrl);
          return {
            to: u.email,
            subject: content.subject,
            textBody: content.textBody,
            htmlBody: content.htmlBody,
          };
        });

        void emailProvider.sendBulk(emails).catch((err) => {
          console.error("[NOTIFY] Failed to send digest emails:", err);
        });
      }

      return result.count;
    },
    deleteNotification: async (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireAuth(context);

      const notification = await context.prisma.notifications.findUnique({
        where: { id: args.id },
      });

      if (!notification || notification.userId !== user.id) {
        throw new GraphQLError("Notification not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.notifications.delete({ where: { id: args.id } });
      return true;
    },
    markNotificationRead: async (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireAuth(context);

      const notification = await context.prisma.notifications.findUnique({
        where: { id: args.id },
      });

      if (!notification || notification.userId !== user.id) {
        throw new GraphQLError("Notification not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.notifications.update({
        where: { id: args.id },
        data: { status: "READ" },
      });
    },
    markAllNotificationsRead: async (_parent: unknown, _args: unknown, context: Context) => {
      const user = requireAuth(context);

      await context.prisma.notifications.updateMany({
        where: { userId: user.id, status: { not: "READ" } },
        data: { status: "READ" },
      });

      return true;
    },
  },
  Notification: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
  },
};
