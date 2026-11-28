import { GraphQLError } from "graphql";
import { eventLink } from "../utils/event-link.js";
import type { Context } from "../context.js";
import type { AlertStatus } from "../generated/prisma/client.js";
import {
  requireContentReader,
  requireRole,
  requireAdminOrTeamAnalystForLocations,
  PIPELINE_ROLE,
  isPipelineRole,
} from "../utils/auth-guard.js";
import { logActivity } from "../utils/activity-log.js";
import { getLocationIdsWithDescendants } from "../utils/geo-resolve.js";
import { buildEventLocationFilterForTeam } from "../utils/location-scope.js";
import { env } from "../utils/env.js";
import { minSeverityFilterFor } from "../utils/alert-severity.js";
import { anyTypeNrcRelevant } from "../utils/nrc-relevance.js";
import { enqueueAlertEmails, flushAlertEmailQueue } from "../services/alert-email.js";
import { fanOutAlertWebhooks } from "../services/webhook/alert-fanout.js";
import { onsetAtRaise, runKindOf } from "../services/event-facts-log.js";
import type { RunKind } from "../services/signal-location-outcomes.js";
import {
  fetchEventLocalizedText,
  normaliseUserLocale,
} from "../utils/alert-email-helpers.js";
import { isPipelineCaller } from "../utils/pipeline-caller.js";
import { recordDecisionIfPerson } from "../services/decision-records.js";

interface CreateAlertInput {
  eventId: string;
  status?: AlertStatus;
  runKind?: RunKind | null;
  pipelineVersion?: string | null;
  runId?: string | null;
}

interface UpdateAlertInput {
  status?: AlertStatus;
}

export const alertResolvers = {
  Query: {
    alerts: async (_parent: unknown, args: { status?: AlertStatus; teamId?: string; includeDummy?: boolean }, context: Context) => {
      requireContentReader(context);
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
      // (no membership check - see signals resolver for rationale).
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
      requireContentReader(context);
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
      requireContentReader(context);
      return context.prisma.alerts.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createAlert: async (
      _parent: unknown,
      args: { input: CreateAlertInput },
      context: Context,
    ) => {
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

      // Elevated gate, scoped to the alert's event locations: a global admin
      // (the pipeline authenticates as one via API key) passes, else the caller
      // must be a team analyst whose location scope covers the event.
      // clear-pipeline's service role writes this too (#430).
      if (!isPipelineRole(context.user)) await requireAdminOrTeamAnalystForLocations(context, [
        event.originId,
        event.destinationId,
        event.locationId,
      ]);

      // Don't raise alerts for out-of-interest events: an event whose types are
      // ALL out-of-interest (disaster_types.nrc_relevant = false) is skipped.
      // An event with at least one NRC-relevant glide code may still alert; an
      // event with no classified types carries no NRC signal and is not skipped.
      // This is expected business behaviour (the pipeline asks to raise an alert
      // for every event it processes), NOT an error — so LOG and return null
      // rather than throwing, which would otherwise surface as a GlitchTip alert
      // on the pipeline side. `createAlert` is nullable for exactly this reason.
      if (
        (event.types?.length ?? 0) > 0 &&
        !(await anyTypeNrcRelevant(context.prisma, event.types))
      ) {
        console.log(
          `[createAlert] Event ${event.id}: types=${JSON.stringify(event.types)} are all NRC-irrelevant — no alert raised (skipping, not an error)`,
        );
        return null;
      }

      // Idempotent creation: if an alert already exists for this event,
      // return it (updating the status if the caller requested a different
      // one). Prevents duplicate alerts when the pipeline retries or when
      // the same event is re-escalated.
      const existingAlert = await context.prisma.alerts.findFirst({
        where: { eventId: input.eventId },
        orderBy: { id: "asc" }, // deterministic: earliest wins
      });
      const statusChange = existingAlert != null && !!input.status && input.status !== existingAlert.status;
      // A person raising an Alert, or changing its status, is a decision
      // (ADR-0024), recorded with the write. The pipeline's alerts are not.
      const alert =
        existingAlert && !statusChange
          ? existingAlert
          : await context.prisma.$transaction(async (tx) => {
              const row = existingAlert
                ? await tx.alerts.update({
                    where: { id: existingAlert.id },
                    data: { status: input.status! },
                  })
                : await tx.alerts.create({
                    data: {
                      eventId: input.eventId,
                      status: input.status ?? "draft",
                      // The onset the Alert is raised on, and the kind of run that
                      // raises it (ADR-0021). Set once: a retry returns the Alert
                      // that exists and changes neither.
                      ...onsetAtRaise(event),
                      raisedByRunKind: isPipelineCaller(context) ? runKindOf(input) : null,
                    },
                  });
              await recordDecisionIfPerson(tx, context, {
                decisionType: existingAlert ? "ALERT_UPDATED" : "ALERT_RAISED",
                subjectType: "alert",
                subjectId: row.id,
                payload: {
                  eventId: input.eventId,
                  status: row.status,
                  previousStatus: existingAlert?.status ?? null,
                },
              });
              return row;
            });

      // Skip the notification fan-out when the alert already existed —
      // subscribers were notified on the original create and must not be
      // spammed on every retry.
      //
      // "Already notified" is the presence of inbox rows, not the presence of
      // the alert. The fan-out (inbox row + notification + queued email) is one
      // transaction, so either a recipient got all three or none of them; an
      // alert with no inbox rows notified nobody, and a retry must be allowed
      // to finish the job. Keyed on the alert row instead, a fan-out that
      // failed after the alert committed was unrepairable — the retry returned
      // here and that alert's email was lost for good.
      //
      // An alert with genuinely no matching subscribers also has no inbox
      // rows, so a retry re-runs a read-only fan-out and finds nobody again.
      // A few wasted queries, and nothing is sent twice.
      if (existingAlert) {
        const alreadyFannedOut = await context.prisma.userAlerts.count({
          where: { alertId: alert.id },
        });
        if (alreadyFannedOut > 0) return alert;
        console.log(
          `[createAlert] Alert ${alert.id} exists with no inbox rows — retrying its fan-out`,
        );
      }

      // First-time creation only — record one activity entry per alert,
      // not one per retry/escalation.
      const actor = context.user;
      if (actor) {
        void logActivity(context.prisma, {
          userId: actor.id,
          action: "alert.create",
          resourceType: "alert",
          resourceId: alert.id,
          metadata: {
            eventId: event.id,
            status: alert.status,
            severity: event.severity,
          },
        });
      }

      // Only PUBLISHED alerts notify. draft/archived are deliberately silent —
      // the pipeline creates archived alerts to record a suppressed (stale /
      // backdated) event without emailing anyone. Fanning out on any status
      // caused a cutover alert storm (40+ emails for weeks-old backfilled events).
      // The activity log above still records the create regardless of status.
      if (alert.status !== "published") return alert;

      // Fan out notifications to immediate subscribers
      const eventLocationIds = [
        event.originId,
        event.destinationId,
        event.locationId,
      ].filter((id): id is string => id !== null);

      console.log(`[createAlert] Event ${event.id}: types=${JSON.stringify(event.types)}, locationIds=${JSON.stringify(eventLocationIds)}`);

      if (eventLocationIds.length === 0) {
        console.log("[createAlert] No locations on event - skipping subscriber notifications");
      } else if (event.types.length === 0) {
        console.log("[createAlert] No types on event - skipping subscriber notifications");
      }

      if (eventLocationIds.length > 0 && event.types.length > 0) {
        // Expand locations to include ancestors so country-level subscriptions
        // match district-level alerts
        const allLocationIds = new Set(eventLocationIds);
        const locations = await context.prisma.locations.findMany({
          where: { id: { in: eventLocationIds } },
          select: { id: true, name: true, level: true, population: true, ancestorIds: true },
        });
        for (const loc of locations) {
          for (const aid of loc.ancestorIds) allLocationIds.add(aid);
        }

        const locationNames = locations.map((l) => l.name).join(", ");
        console.log(`[createAlert] Searching subscribers for types=${JSON.stringify(event.types)}, locations=[${locationNames}] (${allLocationIds.size} IDs including ancestors)`);

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
        console.log(`[createAlert] Found ${subscriptions.length} subscriptions → ${uniqueUserIds.length} unique users`);

        if (uniqueUserIds.length === 0) {
          console.log(`[createAlert] No subscribers found for locations=[${locationNames}] and types=${JSON.stringify(event.types)}`);
        }

        if (uniqueUserIds.length > 0) {
          const fallbackTitle = event.types[0] ?? "Alert";

          // Pull every recipient's language up front: the in-app notification
          // message is written in each recipient's own language, and
          // `emailNotification` decides who gets queued for email below.
          const recipients = await context.prisma.user.findMany({
            where: { id: { in: uniqueUserIds } },
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
          const titleFor = (locale: string) =>
            localizedText.get(normaliseUserLocale(locale))?.title ?? fallbackTitle;

          // The inbox row, the in-app notification and the queued email go in
          // ONE transaction. Email is queued rather than sent — sending inline
          // made a burst of alerts a burst of mail (48 alerts in 3.7s put 48
          // messages in every matching inbox, clear #1731), and the flush is
          // the only place that can see a recipient's whole load for the
          // window and roll it into a digest.
          //
          // Atomic because a partial fan-out is the worst outcome: an alert
          // with an inbox row but no queued email is an alert whose email is
          // silently lost, and a retry returns early at `if (existingAlert)`
          // without repairing it. All-or-nothing makes that unreachable.
          //
          // The inbox half is still immediate; only the email waits for the
          // flush.
          const emailUsers = recipients.filter((r) => r.emailNotification && r.email);
          await context.prisma.$transaction(async (tx) => {
            await tx.userAlerts.createMany({
              data: uniqueUserIds.map((userId) => ({ userId, alertId: alert.id })),
              skipDuplicates: true,
            });
            await tx.notifications.createMany({
              data: recipients.map((r) => ({
                userId: r.id,
                message: `New alert: ${titleFor(r.language)}`,
                notificationType: "alert",
                actionUrl: eventLink(event.id, "inbox"),
                actionText: "View Alert",
              })),
            });
            if (emailUsers.length > 0) {
              await enqueueAlertEmails(tx, alert.id, emailUsers.map((u) => u.id));
            }
          });
          console.log(
            `[createAlert] fan-out: ${uniqueUserIds.length} userAlert row(s), ` +
              `${recipients.length} notification(s), ${emailUsers.length} email(s) queued`,
          );
        }
      }

      // Fan out to team-configured `clear_alert` webhooks alongside email.
      // Fire-and-forget: webhook delivery (async, retried) must never block or
      // fail alert creation. Matching + delivery live in the service.
      try {
        const webhookCount = await fanOutAlertWebhooks(
          context.prisma,
          { id: alert.id, status: alert.status, createdAt: alert.createdAt },
          event,
          env.FRONTEND_URL,
        );
        if (webhookCount > 0) {
          console.log(`[createAlert] Dispatched ${webhookCount} alert webhook delivery(ies)`);
        }
      } catch (e) {
        console.error("[createAlert] alert webhook fan-out failed (alert already created):", e);
      }

      return alert;
    },

    updateAlert: async (
      _parent: unknown,
      args: { id: string; input: UpdateAlertInput },
      context: Context,
    ) => {
      const { id, input } = args;

      const existing = await context.prisma.alerts.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Alert not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Elevated gate, scoped to the alert's event locations: load the alert's
      // event and gate on its locations (admin passes, else team analyst in
      // scope). The alert should always have an event, but if it's missing we
      // fall through with no derivable location → admin-only.
      const alertEvent = await context.prisma.events.findUnique({
        where: { id: existing.eventId },
        select: { originId: true, destinationId: true, locationId: true },
      });
      await requireAdminOrTeamAnalystForLocations(context, [
        alertEvent?.originId,
        alertEvent?.destinationId,
        alertEvent?.locationId,
      ]);

      return context.prisma.$transaction(async (tx) => {
        const updated = await tx.alerts.update({
          where: { id },
          data: {
            status: input.status ?? undefined,
          },
        });
        if (updated.status !== existing.status) {
          await recordDecisionIfPerson(tx, context, {
            decisionType: "ALERT_UPDATED",
            subjectType: "alert",
            subjectId: id,
            payload: { eventId: existing.eventId, status: updated.status, previousStatus: existing.status },
          });
        }
        return updated;
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

      await context.prisma.$transaction(async (tx) => {
        await tx.alerts.delete({ where: { id: args.id } });
        // The record outlives the Alert: it is the only trace of who removed it.
        await recordDecisionIfPerson(tx, context, {
          decisionType: "ALERT_DELETED",
          subjectType: "alert",
          subjectId: args.id,
          payload: { eventId: existing.eventId, status: existing.status },
        });
      });
      return true;
    },

    /**
     * Bulk-archive alerts whose event.lastSignalCreatedAt is older than
     * `olderThanDays` (default 14). One SQL UPDATE via Prisma updateMany.
     * Only targets non-archived alerts so repeat runs are idempotent.
     */
    flushAlertEmails: async (
      _parent: unknown,
      args: { digestThreshold?: number; windowMinutes?: number; maxRecipients?: number },
      context: Context,
    ) => {
      requireRole(context, ["admin", PIPELINE_ROLE]);

      for (const [name, value] of Object.entries(args)) {
        if (value == null) continue;
        if (!Number.isInteger(value) || value < 1) {
          throw new GraphQLError(`${name} must be a positive integer`, {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
      }

      return flushAlertEmailQueue(context.prisma, {
        digestThreshold: args.digestThreshold ?? undefined,
        windowMinutes: args.windowMinutes ?? undefined,
        maxRecipients: args.maxRecipients ?? undefined,
      });
    },
    archiveStaleAlerts: async (
      _parent: unknown,
      args: { olderThanDays?: number },
      context: Context,
    ) => {
      requireRole(context, ["admin", PIPELINE_ROLE]);

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
    // Fast path: when the alert was preloaded via alertsPage's deep
    // include (event + translations + locations + their translations
    // + alerts), the event object is already on the parent. Returning
    // it directly avoids re-fetching without include — which is
    // exactly what made Event.title fall through to the per-request
    // translation loader at non-English locales even after the
    // pagination resolver thought it had pre-loaded everything.
    event: (
      parent: { eventId: string; event?: unknown },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (parent.event !== undefined) return parent.event;
      return prisma.events.findUnique({ where: { id: parent.eventId } });
    },
    representativePoint: (
      parent: { eventId: string; representativePoint?: unknown },
      _args: unknown,
      context: Context,
    ) => {
      if (parent.representativePoint !== undefined) return parent.representativePoint;
      return context.representativePointLoader.load(parent.eventId);
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
