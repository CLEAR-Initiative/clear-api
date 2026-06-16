import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { NotificationStatus, PrismaClient } from "../generated/prisma/client.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { env } from "../utils/env.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import { alertNotification, alertDigest } from "../services/messaging/templates.js";
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
  eventSeverity?: number | null,
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

  // Events with unknown severity default to 1 (match all subscribers)
  const effectiveSeverity = eventSeverity ?? 1;

  const subscriptions = await prisma.userAlertSubscriptions.findMany({
    where: {
      active: true,
      frequency,
      alertType: { in: eventTypes },
      locationId: { in: [...allLocationIds] },
      minSeverity: { lte: effectiveSeverity },
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
        include: {
          event: {
            include: {
              generalLocation: { select: { id: true, name: true, level: true, population: true, ancestorIds: true } },
              originLocation: { select: { id: true, name: true, level: true, population: true, ancestorIds: true } },
            },
          },
        },
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
        event.severity,
      );

      if (userIds.length === 0) return 0;

      const fallbackTitle = event.types[0] ?? "Alert";
      const alertUrl = `${env.FRONTEND_URL}/event/${event.id}`;

      // Pull recipients up front so one Prisma read covers both the
      // per-recipient in-app message text and the per-recipient email
      // body. Each user sees the title + description in their own
      // language (falling through to canonical English when no
      // translation row exists for that locale).
      const recipients = await context.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true, language: true, emailNotification: true },
      });
      const uniqueLocales = [
        ...new Set(recipients.map((r) => normaliseUserLocale(r.language))),
      ];
      const localizedText = await fetchEventLocalizedText(
        context.prisma,
        event.id,
        event.title,
        event.description,
        uniqueLocales,
      );
      const titleFor = (locale: string | null) =>
        localizedText.get(normaliseUserLocale(locale))?.title ?? fallbackTitle;
      const descriptionFor = (locale: string | null) =>
        localizedText.get(normaliseUserLocale(locale))?.description ?? event.description;

      // 1. Populate userAlerts join table
      await context.prisma.userAlerts.createMany({
        data: userIds.map((userId) => ({
          userId,
          alertId: alert.id,
        })),
        skipDuplicates: true,
      });

      // 2. Create in-app notifications (per-recipient title localization).
      const result = await context.prisma.notifications.createMany({
        data: recipients.map((r) => ({
          userId: r.id,
          message: `New alert: ${titleFor(r.language)}`,
          notificationType: "alert",
          actionUrl: `/event/${event.id}`,
          actionText: "View Alert",
        })),
      });

      // 3. Send email notifications to users who have email notifications enabled
      const emailUsers = recipients.filter((r) => r.emailNotification);

      if (emailUsers.length > 0) {
        const emailProvider = await getEmailProvider();
        const primaryLoc = event.generalLocation ?? event.originLocation ?? null;
        const [emailLoc, eventTypeLabel, signalLocs] = await Promise.all([
          resolveEmailLocation(context.prisma, primaryLoc),
          resolveEventTypeLabel(context.prisma, event.types),
          fetchEventSignalLocations(context.prisma, event.id),
        ]);

        // Localized names for every location id that may appear in any
        // per-recipient email. One Prisma read covers all (id, locale)
        // pairs across the batch.
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

        const population = emailLoc?.population ? formatCount(emailLoc.population) : null;
        const severityLabel = severityToLabel(event.severity);
        const affectedPeople = event.populationAffected != null
          ? formatCount(event.populationAffected)
          : null;

        const emails = emailUsers
          .filter((u) => u.email)
          .map((u) => {
            // Per-recipient locale — every location name swaps to the
            // user's language when a translation row exists, otherwise
            // canonical English.
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
          });

        // Fire-and-forget - don't block the response on email delivery
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
        select: { userId: true, alertType: true, locationId: true, minSeverity: true },
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
          const severityMatch = (alert.event.severity ?? 1) >= sub.minSeverity;

          if (typesMatch && locationMatch && severityMatch) {
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
