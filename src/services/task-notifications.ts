/**
 * Notification fan-out for Task outcomes (ADR-0010, V2). When an
 * `event.impact_prior.*` Task completes or fails, the requester, the Task's
 * team analysts (Events have no team; the Task carries the requester's
 * view-scope team) and every platform admin get an in-app notification
 * with a link to the Event page, and an email when they opted in — the
 * `escalateEvent` fan-out shape. Best-effort: a failure here is logged and
 * never surfaces to the Worker whose write triggered it.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../utils/env.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import { taskOutcome as taskOutcomeEmail } from "../services/messaging/templates.js";
import { taskKindLabel } from "../utils/task-kinds.js";

export type TaskOutcomeKind = "completed" | "failed";

export interface TaskForNotification {
  id: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  requesterId: string | null;
  teamId: string | null;
  outcome: string | null;
  lastError: string | null;
}

export interface TaskRecipient {
  id: string;
  name: string;
  email: string;
  language: string;
  emailNotification: boolean;
  /** May read the Task's error: the requester and platform admins. */
  seesError: boolean;
}

/**
 * Who hears about a Task's outcome: its requester, platform admins, and
 * analysts who are members of the Task's team. De-duplicated; an inactive
 * account is left out.
 */
export async function taskRecipients(prisma: PrismaClient, task: TaskForNotification): Promise<TaskRecipient[]> {
  const select = { id: true, name: true, email: true, language: true, emailNotification: true } as const;
  const [requester, admins, teamAnalysts] = await Promise.all([
    task.requesterId
      ? prisma.user.findMany({ where: { id: task.requesterId, isActive: true }, select })
      : Promise.resolve([]),
    prisma.user.findMany({ where: { role: "admin", isActive: true }, select }),
    task.teamId
      ? prisma.user.findMany({
          where: { role: "analyst", isActive: true, teamMemberships: { some: { teamId: task.teamId } } },
          select,
        })
      : Promise.resolve([]),
  ]);
  const byId = new Map<string, TaskRecipient>();
  for (const u of teamAnalysts) byId.set(u.id, { ...u, seesError: false });
  for (const u of [...requester, ...admins]) byId.set(u.id, { ...u, seesError: true });
  return [...byId.values()];
}

/** The in-app message, in the recipient's terms: what the Task was, which
 *  source did it (several Workers propose on one Event, so the recipient
 *  hears from each) and how it ended. */
export function taskOutcomeMessage(task: TaskForNotification, outcomeKind: TaskOutcomeKind): string {
  const what = taskKindLabel(task.kind);
  if (outcomeKind === "failed") return `${what} enrichment failed`;
  if (task.outcome === "no_prior_found") return `${what}: no prior found`;
  return `${what} proposed — review it`;
}

/**
 * Fan out one Task outcome. Writes the in-app rows first (they are the
 * record), then emails opted-in recipients fire-and-forget. Never throws.
 */
export async function notifyTaskOutcome(
  prisma: PrismaClient,
  task: TaskForNotification,
  outcomeKind: TaskOutcomeKind,
): Promise<void> {
  try {
    const recipients = await taskRecipients(prisma, task);
    if (recipients.length === 0) return;
    const actionUrl = task.subjectType === "event" ? `/event/${task.subjectId}` : null;
    const message = taskOutcomeMessage(task, outcomeKind);

    await prisma.notifications.createMany({
      data: recipients.map((r) => ({
        userId: r.id,
        message,
        notificationType: "task",
        actionUrl,
        actionText: actionUrl ? "View Event" : null,
      })),
    });

    const emailUsers = recipients.filter((r) => r.emailNotification && r.email);
    if (emailUsers.length === 0) return;
    const eventUrl = actionUrl ? `${env.FRONTEND_URL}${actionUrl}` : env.FRONTEND_URL;
    void (async () => {
      try {
        const provider = await getEmailProvider();
        await provider.sendBulk(
          emailUsers.map((u) => {
            const content = taskOutcomeEmail(u.name, message, eventUrl, {
              outcomeKind,
              // The error is the requester's and admins' to see; team analysts get the outcome only.
              error: outcomeKind === "failed" && u.seesError ? task.lastError : null,
            });
            return { to: u.email, subject: content.subject, textBody: content.textBody, htmlBody: content.htmlBody };
          }),
        );
      } catch (err) {
        console.error(`[task-notifications] failed to email outcome of task=${task.id}:`, err);
      }
    })();
  } catch (err) {
    console.error(`[task-notifications] failed to notify outcome of task=${task.id}:`, err);
  }
}
