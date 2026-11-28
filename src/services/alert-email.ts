/**
 * Alert email: queue it, then flush it in batches.
 *
 * `createAlert` used to hand each alert's email to the provider inline, so the
 * number of messages a subscriber received was exactly the number of alerts the
 * pipeline happened to raise. On 2026-11-28 the `sudan-war-x` poller came back
 * from a 47-hour outage, pushed its whole backlog at once, and one Dagster run
 * raised 48 alerts in 3.7 seconds — 48 separate emails per matching subscriber,
 * against a prior busiest *whole day* of 28 (clear #1731).
 *
 * So the send is no longer inline. `enqueueAlertEmails` records that a
 * recipient is owed an email, and `flushAlertEmailQueue` — driven by a Dagster
 * schedule — is the one place that can see how much mail a recipient is about
 * to get. Above `digestThreshold` alerts in the rolling window it sends a
 * single digest instead of one message each.
 *
 * What did NOT move: the alert row, the in-app notification and the webhook
 * fan-out all still happen inline in `createAlert`. The inbox stays live; only
 * email is batched, because email is the channel that floods.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { eventLink, withLinkSource } from "../utils/event-link.js";
import { env } from "../utils/env.js";
import { getEmailProvider } from "./messaging/registry.js";
import { alertNotification, alertDigest } from "./messaging/templates.js";
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

/**
 * Rows one flush reads at most. Generous — a flush normally sees a handful —
 * but finite, so an unflushed queue degrades into several ticks rather than one
 * enormous allocation.
 */
const MAX_QUEUE_SCAN = 10_000;

/** One message ready for the provider. */
interface OutboundEmail {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}

/** A recipient of alert email, as the queue needs them. */
interface Recipient {
  id: string;
  name: string;
  email: string | null;
  language: string | null;
}

export interface FlushResult {
  /** Recipients the flush sent something to. */
  recipients: number;
  /** Queue rows covered by an individual email (one row, one message). */
  individual: number;
  /** Queue rows rolled into a digest. */
  digested: number;
  /** Digest emails sent — one per recipient who crossed the threshold. */
  digests: number;
  /** Messages handed to the provider in total. */
  emails: number;
  /** Recipients whose send threw; their rows stay pending for the next flush. */
  failed: number;
}

/**
 * Record that each of `userIds` is owed an email about `alertId`.
 *
 * `skipDuplicates` against the `(userId, alertId)` unique index makes this
 * safe to call twice: a retried `createAlert` must not queue a second email
 * for an alert the recipient already has one pending or sent for.
 *
 * Only call with recipients who actually take email (`emailNotification`);
 * the in-app audience is larger and is served by `userAlerts`.
 *
 * This is a separate call rather than a column on `userAlerts` because that
 * table is written from four places — `createAlert`, `notifyAlertSubscribers`,
 * `notifyAlertDigest` and `event.resolver`. An `emailedAt` there would make
 * all four implicitly enqueue email, including `notifyAlertSubscribers`, which
 * already sends its own: double sends, not a naming preference.
 */
export async function enqueueAlertEmails(
  /** The client or an interactive-transaction client — only `createMany` is used,
   *  so the enqueue can join the rest of the fan-out in one transaction. */
  prisma: { alertEmailQueue: Pick<PrismaClient["alertEmailQueue"], "createMany"> },
  alertId: string,
  userIds: string[],
): Promise<number> {
  if (userIds.length === 0) return 0;
  const { count } = await prisma.alertEmailQueue.createMany({
    data: userIds.map((userId) => ({ userId, alertId })),
    skipDuplicates: true,
  });
  return count;
}

/**
 * Build the individual alert email for one alert, one message per recipient.
 *
 * Lifted verbatim-in-behaviour out of `createAlert` so the flush can send the
 * same email the resolver used to send: every per-recipient string — title,
 * description, location names, severity chip and the template's own chrome —
 * still resolves through that recipient's locale.
 */
async function buildIndividualEmails(
  prisma: PrismaClient,
  alertId: string,
  recipients: Recipient[],
): Promise<OutboundEmail[]> {
  const alert = await prisma.alerts.findUnique({
    where: { id: alertId },
    include: { event: true },
  });
  if (!alert?.event) return [];
  const event = alert.event;

  const withEmail = recipients.filter((r) => r.email);
  if (withEmail.length === 0) return [];

  const eventLocationIds = [event.originId, event.destinationId, event.locationId].filter(
    (id): id is string => id !== null,
  );
  const locations =
    eventLocationIds.length > 0
      ? await prisma.locations.findMany({
          where: { id: { in: eventLocationIds } },
          select: { id: true, name: true, level: true, population: true, ancestorIds: true },
        })
      : [];

  const primaryLoc =
    locations.find((l) => l.id === event.locationId) ??
    locations.find((l) => l.id === event.originId) ??
    locations.find((l) => l.id === event.destinationId) ??
    null;

  const [emailLoc, eventTypeLabel, signalLocs] = await Promise.all([
    resolveEmailLocation(prisma, primaryLoc),
    resolveEventTypeLabel(prisma, event.types),
    fetchEventSignalLocations(prisma, event.id),
  ]);

  const uniqueLocales = [...new Set(withEmail.map((r) => normaliseUserLocale(r.language)))];
  const localizedText = await fetchEventLocalizedText(
    prisma,
    event.id,
    event.title,
    event.description,
    uniqueLocales,
  );
  const localizedNames = await localizeLocationNames(
    prisma,
    [
      ...(primaryLoc?.id ? [primaryLoc.id] : []),
      ...(emailLoc?.id ? [emailLoc.id] : []),
      ...signalLocs.ids,
    ],
    uniqueLocales,
  );

  const fallbackTitle = event.types[0] ?? "Alert";
  const alertUrl = eventLink(event.id, "email", env.FRONTEND_URL);
  const severityLabel = severityToLabel(event.severity);
  const populationStr = emailLoc?.population ? formatCount(emailLoc.population) : null;
  const affectedPeopleStr =
    event.populationAffected != null ? formatCount(event.populationAffected) : null;

  return withEmail.map((u) => {
    const recipientLocale = normaliseUserLocale(u.language);
    const localizedSignalNames = signalLocs.ids
      .map(
        (id, idx) =>
          pickLocalizedName(localizedNames, id, recipientLocale, signalLocs.names[idx] ?? null) ??
          signalLocs.names[idx],
      )
      .filter((n): n is string => !!n);
    const content = alertNotification(
      u.name,
      localizedText.get(recipientLocale)?.title ?? fallbackTitle,
      localizedText.get(recipientLocale)?.description ?? event.description,
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
        population: populationStr,
        affectedPeople: affectedPeopleStr,
        districtName: pickLocalizedName(
          localizedNames,
          primaryLoc?.id,
          recipientLocale,
          primaryLoc?.name ?? null,
        ),
        signalLocations: localizedSignalNames,
        signalLocationsOverflow: signalLocs.overflow,
        locale: recipientLocale,
      },
    );
    return {
      to: u.email!,
      subject: content.subject,
      textBody: content.textBody,
      htmlBody: content.htmlBody,
    };
  });
}

/**
 * Build one digest email covering several alerts for one recipient.
 *
 * Each line's title and description come from the recipient's locale where a
 * translation row exists, and the template's chrome renders in that locale too.
 * `maxItems` caps what the body lists — a recipient owed 400 alerts gets a
 * readable email that says how many were left out, not a 400-row wall.
 */
async function buildDigestEmail(
  prisma: PrismaClient,
  recipient: Recipient,
  alertIds: string[],
  maxItems: number,
): Promise<OutboundEmail | null> {
  if (!recipient.email || alertIds.length === 0) return null;

  const alerts = await prisma.alerts.findMany({
    where: { id: { in: alertIds } },
    include: { event: true },
    orderBy: { createdAt: "desc" },
  });
  if (alerts.length === 0) return null;

  const locale = normaliseUserLocale(recipient.language);
  const shown = alerts.slice(0, maxItems);
  const items = await Promise.all(
    shown.map(async (a) => {
      const localized = await fetchEventLocalizedText(
        prisma,
        a.event.id,
        a.event.title,
        a.event.description,
        [locale],
      );
      return {
        title: localized.get(locale)?.title ?? a.event.title ?? a.event.types[0] ?? "Alert",
        description: localized.get(locale)?.description ?? a.event.description,
        url: eventLink(a.event.id, "email", env.FRONTEND_URL),
      };
    }),
  );

  const content = alertDigest(recipient.name, items, {
    locale,
    // The alert list, not an event — `eventLink` with an empty id would build
    // a dead `/event/?from=email`.
    dashboardUrl: withLinkSource(`${env.FRONTEND_URL.replace(/\/$/, "")}/detection`, "email"),
    totalCount: alerts.length,
  });
  return {
    to: recipient.email,
    subject: content.subject,
    textBody: content.textBody,
    htmlBody: content.htmlBody,
  };
}

/**
 * Send the queued alert email, deciding per recipient whether it goes out as
 * individual messages or as one digest.
 *
 * **Claim, then send, then mark.** A row is claimed before any message is
 * built, because two flushes can genuinely overlap: the poll sensor allows a
 * run alongside a STARTED one (`poll_sensor._WAITING_STATUSES`) and an admin
 * can call the mutation by hand. Read-then-send without claiming would let both
 * read the same pending rows and send the same email twice.
 *
 * A claim is a **lease**, not a lock. A flush that dies mid-send leaves rows
 * claimed; a claim older than `claimTtlMinutes` is treated as abandoned and may
 * be taken again. So a crash costs at most one duplicate, never a permanently
 * stuck email — the opposite trade-off (mark sent first) loses email silently.
 *
 * `sendBulk` returns one boolean per message and does **not** throw when a
 * provider refuses one, so only the rows covered by an accepted message are
 * marked sent. A refused or thrown message releases its rows back to pending
 * for the next flush.
 *
 * The burst size is `max(window count, rows claimed now)`. The window alone is
 * not enough: if the flush is down for longer than the window after 48 alerts
 * are queued, every one of them ages out of it, the count reads zero, and the
 * recovery flush would send 48 individual emails — recreating the flood in
 * exactly the scenario the mechanism exists for.
 */
export async function flushAlertEmailQueue(
  prisma: PrismaClient,
  opts: {
    now?: Date;
    /** More than this many alerts for one recipient ⇒ one digest instead. */
    digestThreshold?: number;
    /** Length of the rolling window, in minutes. */
    windowMinutes?: number;
    /** Most alerts a digest body lists before "+N more". */
    maxDigestItems?: number;
    /** Recipients handled in one flush; the rest wait for the next tick. */
    maxRecipients?: number;
    /** A claim older than this is abandoned and may be retaken. */
    claimTtlMinutes?: number;
  } = {},
): Promise<FlushResult> {
  const now = opts.now ?? new Date();
  const digestThreshold = opts.digestThreshold ?? env.ALERT_EMAIL_DIGEST_THRESHOLD;
  const windowMinutes = opts.windowMinutes ?? env.ALERT_EMAIL_WINDOW_MINUTES;
  const maxDigestItems = opts.maxDigestItems ?? env.ALERT_EMAIL_MAX_DIGEST_ITEMS;
  const maxRecipients = opts.maxRecipients ?? env.ALERT_EMAIL_MAX_RECIPIENTS_PER_FLUSH;
  const claimTtlMinutes = opts.claimTtlMinutes ?? env.ALERT_EMAIL_CLAIM_TTL_MINUTES;

  const result: FlushResult = {
    recipients: 0,
    individual: 0,
    digested: 0,
    digests: 0,
    emails: 0,
    failed: 0,
  };

  const staleBefore = new Date(now.getTime() - claimTtlMinutes * 60_000);
  /** Unsent, and either unclaimed or holding an abandoned claim. */
  const available = {
    sentAt: null,
    OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
  };

  // Bounded read: a queue nobody has flushed for a day must not be loaded
  // whole. Oldest first, so nothing is starved — a recipient whose rows fall
  // beyond the cut is simply served by the next tick.
  const candidates = await prisma.alertEmailQueue.findMany({
    where: available,
    orderBy: { queuedAt: "asc" },
    take: MAX_QUEUE_SCAN,
    select: { userId: true },
  });
  if (candidates.length === 0) return result;

  // Distinct recipients, in the order their oldest row appeared.
  const userIds: string[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    userIds.push(row.userId);
    if (userIds.length >= maxRecipients) break;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true, language: true, emailNotification: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const windowStart = new Date(now.getTime() - windowMinutes * 60_000);
  const emailProvider = await getEmailProvider();

  for (const userId of userIds) {
    // Claim this recipient's available rows. Only what comes back is ours —
    // a concurrent flush that claimed some of them first gets those, and we
    // simply do not see them.
    const claimed = await prisma.alertEmailQueue.updateManyAndReturn({
      where: { userId, ...available },
      data: { claimedAt: now },
      select: { id: true, alertId: true },
    });
    if (claimed.length === 0) continue; // another flush owns them

    const rowIds = claimed.map((r) => r.id);
    const user = userById.get(userId);

    if (!user || !user.emailNotification || !user.email) {
      // Resolved without sending: `sentAt` set so the row stops being re-read,
      // `delivery` left null because no email carried it. Claiming
      // "individual" here would misreport the flush in the only durable record
      // of what each recipient was actually sent.
      await markSent(prisma, rowIds, null, now);
      continue;
    }

    // Everything raised for this recipient inside the window, sent or not, so
    // a burst split across two flush ticks is judged as one burst — floored at
    // what we just claimed, so a burst that has aged out of the window still
    // counts as one (see the doc comment).
    const windowCount = await prisma.alertEmailQueue.count({
      where: { userId, queuedAt: { gte: windowStart } },
    });
    const burstCount = Math.max(windowCount, claimed.length);

    const recipient: Recipient = {
      id: user.id,
      name: user.name,
      email: user.email,
      language: user.language,
    };

    try {
      if (burstCount > digestThreshold) {
        const digest = await buildDigestEmail(
          prisma,
          recipient,
          claimed.map((r) => r.alertId),
          maxDigestItems,
        );
        if (!digest) {
          await markSent(prisma, rowIds, "digest", now);
          continue;
        }
        const [accepted] = await emailProvider.sendBulk([digest]);
        if (accepted === false) {
          // Refused, not thrown: release every row the digest covered.
          await release(prisma, rowIds);
          result.failed += 1;
          continue;
        }
        await markSent(prisma, rowIds, "digest", now);
        result.digests += 1;
        result.emails += 1;
        result.digested += rowIds.length;
        result.recipients += 1;
        continue;
      }

      // Under the threshold: one email per alert, exactly as before. Each
      // message is tracked against the row it covers, so a provider that
      // refuses message 3 of 5 releases only that row.
      const tracked: Array<{ rowId: string; message: OutboundEmail }> = [];
      for (const row of claimed) {
        for (const message of await buildIndividualEmails(prisma, row.alertId, [recipient])) {
          tracked.push({ rowId: row.id, message });
        }
      }
      if (tracked.length === 0) {
        // Nothing to send for these (e.g. the alert or its event is gone).
        await markSent(prisma, rowIds, null, now);
        continue;
      }

      const results = await emailProvider.sendBulk(tracked.map((t) => t.message));
      const sentIds: string[] = [];
      const refusedIds: string[] = [];
      tracked.forEach((t, i) => {
        (results[i] === false ? refusedIds : sentIds).push(t.rowId);
      });
      // A row whose message was never built (no message for that alert) is
      // closed, not left to be re-read forever.
      const builtIds = new Set(tracked.map((t) => t.rowId));
      const unbuilt = rowIds.filter((id) => !builtIds.has(id));

      if (sentIds.length > 0 || unbuilt.length > 0) {
        await markSent(prisma, [...sentIds, ...unbuilt], "individual", now);
        result.individual += sentIds.length + unbuilt.length;
      }
      if (refusedIds.length > 0) {
        await release(prisma, refusedIds);
        result.failed += 1;
      }
      if (sentIds.length > 0) {
        result.emails += sentIds.length;
        result.recipients += 1;
      }
    } catch (err) {
      // One recipient's failure must not strand the others: release their rows
      // so the next tick retries just them.
      console.error(`[alert-email] flush failed for user ${userId}:`, err);
      await release(prisma, rowIds).catch((e) =>
        console.error(`[alert-email] could not release rows for ${userId}:`, e),
      );
      result.failed += 1;
    }
  }

  console.log(
    `[alert-email] flush: recipients=${result.recipients} emails=${result.emails} ` +
      `individual=${result.individual} digested=${result.digested} digests=${result.digests} ` +
      `failed=${result.failed}`,
  );
  return result;
}

async function markSent(
  prisma: PrismaClient,
  rowIds: string[],
  /** Null = closed without an email (recipient has email off, or no address). */
  delivery: "individual" | "digest" | null,
  now: Date,
): Promise<void> {
  if (rowIds.length === 0) return;
  await prisma.alertEmailQueue.updateMany({
    where: { id: { in: rowIds } },
    data: { sentAt: now, delivery },
  });
}

/** Hand rows back to the queue: still unsent, no longer claimed. */
async function release(prisma: PrismaClient, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await prisma.alertEmailQueue.updateMany({
    where: { id: { in: rowIds } },
    data: { claimedAt: null },
  });
}
