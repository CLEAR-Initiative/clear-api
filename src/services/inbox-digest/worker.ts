/**
 * Daily Inbox digest (Exponential #1655, D-0279): once a day, post how many
 * Inbox items wait for a decision, over all teams, to the Matrix room that
 * GlitchTip alerts use, with a link to /inbox. For the CLEAR team: nobody
 * sees a new Location challenge or unresolved place name until they open
 * the Inbox.
 *
 * Runs in-process on an interval, like the activity-log trim worker
 * (src/services/activity-log/trim-worker.ts). A tick posts when the clock is
 * in the digest hour (07:00 to 08:00 UTC) and this process has not posted
 * today. Outside that hour a tick does nothing, so a deploy later in the day
 * posts no second digest; a process that is down for the whole hour posts
 * none that day.
 *
 * Several replicas post one digest: each sends the transaction id
 * `inbox-digest-<app host>-<UTC date>`, and the homeserver takes one message per id. A
 * homeserver forgets old ids (Synapse: after about 30 minutes), so the id
 * covers replicas that tick together and a restart inside the hour, not a
 * whole day; the digest hour covers the rest.
 */

import type { PrismaClient } from "../../generated/prisma/client.js";
import { OPEN_CHALLENGE_STATUS } from "../../resolvers/signalLocationChallenge.resolver.js";
import {
  escapeHtml,
  postMatrixMessage,
  type FetchLike,
  type MatrixConfig,
  type MatrixMessage,
} from "../webhook/matrix.js";

/** The UTC hour in which the digest is posted. */
export const INBOX_DIGEST_HOUR_UTC = 7;

const TICK_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60_000;

/** Inbox items that wait for a decision, over all teams. */
export interface InboxCounts {
  /** Open Location challenges, by who filed them. */
  locationChanges: { person: number; pipeline: number };
  /** Open rows of the unresolved place-name queue. */
  places: number;
  /** Proposed signals (web cases) nobody has accepted or rejected. */
  proposedSignals: number;
}

export async function countWaitingInboxItems(prisma: PrismaClient): Promise<InboxCounts> {
  const [challenges, places, proposedSignals] = await Promise.all([
    prisma.signalLocationChallenges.groupBy({
      by: ["origin"],
      where: { status: OPEN_CHALLENGE_STATUS },
      _count: { _all: true },
    }),
    prisma.unresolvedPlaceNames.count({ where: { status: "open" } }),
    prisma.caseProposal.count({ where: { state: "proposed" } }),
  ]);
  const byOrigin = (origin: string) => challenges.find((c) => c.origin === origin)?._count._all ?? 0;
  return {
    locationChanges: { person: byOrigin("PERSON"), pipeline: byOrigin("PIPELINE") },
    places,
    proposedSignals,
  };
}

/** The digest as a Matrix message. `frontendUrl` is the app's base URL. */
export function formatInboxDigest(counts: InboxCounts, frontendUrl: string): MatrixMessage {
  const link = `${frontendUrl.replace(/\/+$/, "")}/inbox`;
  const { person, pipeline } = counts.locationChanges;
  const total = person + pipeline + counts.places + counts.proposedSignals;
  if (total === 0) {
    return {
      body: `📥 Inbox: nothing waits for a decision.\n${link}`,
      formattedBody: `📥 <strong>Inbox:</strong> nothing waits for a decision. <a href="${escapeHtml(link)}">Open the Inbox</a>`,
    };
  }
  const lines = [
    `Location changes: ${person + pipeline} (${person} from people, ${pipeline} from the pipeline)`,
    `Places: ${counts.places}`,
    `Proposed signals: ${counts.proposedSignals}`,
  ];
  const heading = `${total} ${total === 1 ? "item waits" : "items wait"} for a decision`;
  return {
    body: [`📥 Inbox: ${heading}`, ...lines, link].join("\n"),
    formattedBody: [
      `📥 <strong>Inbox:</strong> ${heading}`,
      ...lines.map(escapeHtml),
      `<a href="${escapeHtml(link)}">Open the Inbox</a>`,
    ].join("<br/>"),
  };
}

export interface InboxDigestDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** The instant the digest is for. Default: now. */
  now?: Date;
}

/** Count and post one digest. Returns true when the homeserver took it. */
export async function postInboxDigest(
  prisma: PrismaClient,
  config: MatrixConfig,
  frontendUrl: string,
  deps: InboxDigestDeps = {},
): Promise<boolean> {
  const counts = await countWaitingInboxItems(prisma);
  // One transaction id per UTC day: every replica sends the same id, and the
  // homeserver keeps one message for it.
  return postMatrixMessage(config, formatInboxDigest(counts, frontendUrl), {
    ...deps,
    txnId: digestTxnId(frontendUrl, deps.now ?? new Date()),
  });
}

/** `inbox-digest-<app host>-<UTC date>`. The host keeps dev and prod apart
 *  when both post to one room with one bot token: without it the homeserver
 *  would keep only the first of the two digests. */
export function digestTxnId(frontendUrl: string, now: Date): string {
  let host = "app";
  try {
    host = new URL(frontendUrl).host.replace(/[^a-z0-9.-]/gi, "-");
  } catch {
    // Not a URL: one environment's digests still share an id.
  }
  return `inbox-digest-${host}-${utcDate(now)}`;
}

/** The UTC date of `now`, as YYYY-MM-DD. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whether a tick at `now` posts: in the digest hour, and not posted today. */
export function digestDue(now: Date, lastPostedDate: string | null): boolean {
  return now.getUTCHours() === INBOX_DIGEST_HOUR_UTC && utcDate(now) !== lastPostedDate;
}

let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
let lastPostedDate: string | null = null;

async function tick(
  prisma: PrismaClient,
  config: MatrixConfig,
  frontendUrl: string,
  deps: InboxDigestDeps,
): Promise<void> {
  const now = new Date();
  if (!digestDue(now, lastPostedDate)) return;
  try {
    // A failed post leaves the day open: the next tick in the hour tries again.
    if (await postInboxDigest(prisma, config, frontendUrl, { ...deps, now })) lastPostedDate = utcDate(now);
  } catch (err) {
    console.error("[inbox-digest] run failed:", err);
  }
}

/** Start the digest schedule. Does nothing and returns false when Matrix is
 *  not configured (`config` is null), as the GlitchTip path does. Idempotent:
 *  calling twice is a no-op. */
export function startInboxDigestWorker(
  prisma: PrismaClient,
  config: MatrixConfig | null,
  frontendUrl: string,
  deps: InboxDigestDeps = {},
): boolean {
  if (config === null) return false;
  if (timer !== null) return true;
  const run = () => void tick(prisma, config, frontendUrl, deps);
  firstRun = setTimeout(() => {
    firstRun = null;
    run();
  }, FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  timer = setInterval(run, TICK_MS);
  timer.unref?.();
  return true;
}

/** Stop the schedule (tests / graceful shutdown). */
export function stopInboxDigestWorker(): void {
  if (firstRun !== null) clearTimeout(firstRun);
  if (timer !== null) clearInterval(timer);
  firstRun = null;
  timer = null;
  lastPostedDate = null;
}
