/**
 * Accepting a web case writes it into CLEAR as history (ADR-0010 amendment,
 * V4). The case becomes a Signal — the source URL is its Source, the date
 * the incident happened is its `publishedAt` — on the Event it describes:
 * the CLEAR Event the Worker matched, the Event that already carries the
 * same article, or a new historical Event dated to the incident.
 *
 * The Dagster drain never sees these Signals (they are written PROCESSED),
 * because its grouping only matches Events active in the last few days of
 * wall-clock time and would file every backdated Signal as a new Event.
 * Alerts stay away on their own: `eventsPendingAlert` only returns Events
 * whose newest Signal is under 48 hours old, and a historical Event's
 * newest Signal is the incident's date.
 */

import { createHash } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";

/** The DataSource every accepted web case is filed under (seeded by the
 *  `add_case_proposals` migration). */
export const WEB_ENRICHMENT_SOURCE = "web_enrichment";
/** How long a historical Event counts as open after its onset, the same
 *  window the pipeline gives a new Event. */
const HISTORICAL_EVENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TITLE_MAX = 200;

type Tx = Prisma.TransactionClient;

export interface AcceptedCase {
  id: string;
  sourceUrl: string;
  quote: string;
  occurredAt: Date;
  locationLabel: string;
  locationId: string | null;
  hazardType: string;
  matchedEventId: string | null;
  methodVersion: string;
}

export interface AcceptanceResult {
  signalId: string;
  eventId: string;
  /** Whether a new historical Event was created (vs. an existing one used). */
  createdEvent: boolean;
}

async function webEnrichmentSourceId(tx: Tx): Promise<string> {
  const existing = await tx.dataSources.findFirst({
    where: { name: WEB_ENRICHMENT_SOURCE },
    select: { id: true },
  });
  if (existing) return existing.id;
  // The migration seeds it; recreate it if someone removed it rather than
  // fail every accept.
  const created = await tx.dataSources.create({
    data: { name: WEB_ENRICHMENT_SOURCE, type: "web" },
    select: { id: true },
  });
  return created.id;
}

/**
 * Write one accepted case into CLEAR. Must run inside the transaction that
 * moved the case to `accepted`, so a failure here leaves it `proposed`.
 *
 * - A Signal with the same URL already in CLEAR, from any source, is reused
 *   rather than duplicated (exact-duplicate removal is the one judgement the
 *   ontology allows at ingestion); otherwise a new Signal is written.
 * - The Event is, in order: the Worker's matched Event; an Event the reused
 *   Signal already sits on; a new historical Event.
 * - Linking a Signal to an existing Event widens its first/last Signal
 *   times to cover the incident but never moves them inward, so a backdated
 *   Signal cannot make a live Event look stale.
 */
export async function acceptCase(
  tx: Tx,
  c: AcceptedCase,
  opts: { userId: string; fallbackLocationId: string | null; now: Date },
): Promise<AcceptanceResult> {
  const reused = await tx.signals.findFirst({
    where: { url: c.sourceUrl },
    orderBy: { publishedAt: "asc" },
    select: { id: true, signalEvents: { select: { eventId: true }, take: 1, orderBy: { collectedAt: "asc" } } },
  });

  const signalId = reused
    ? reused.id
    : (
        await tx.signals.create({
          data: {
            sourceId: await webEnrichmentSourceId(tx),
            // One Signal per URL: the unique (source, externalId) stops a
            // concurrent accept of the same article writing it twice.
            externalId: `url:${createHash("sha256").update(c.sourceUrl).digest("hex")}`,
            rawData: {
              caseProposalId: c.id,
              quote: c.quote,
              locationLabel: c.locationLabel,
              hazardType: c.hazardType,
              methodVersion: c.methodVersion,
              acceptedBy: opts.userId,
            },
            publishedAt: c.occurredAt,
            collectedAt: opts.now,
            status: "PROCESSED",
            processedAt: opts.now,
            url: c.sourceUrl,
            description: c.quote,
            locationId: c.locationId,
            submittedById: opts.userId,
          },
          select: { id: true },
        })
      ).id;

  const existingEventId = c.matchedEventId ?? reused?.signalEvents[0]?.eventId ?? null;
  const existing = existingEventId
    ? await tx.events.findUnique({
        where: { id: existingEventId },
        select: { id: true, firstSignalCreatedAt: true, lastSignalCreatedAt: true },
      })
    : null;

  if (existing) {
    await tx.signalEvents.upsert({
      where: { signalId_eventId: { signalId, eventId: existing.id } },
      create: { signalId, eventId: existing.id, collectedAt: opts.now },
      update: {},
    });
    const widen: Prisma.eventsUpdateInput = {};
    if (c.occurredAt < existing.firstSignalCreatedAt) widen.firstSignalCreatedAt = c.occurredAt;
    if (c.occurredAt > existing.lastSignalCreatedAt) widen.lastSignalCreatedAt = c.occurredAt;
    if (Object.keys(widen).length > 0) await tx.events.update({ where: { id: existing.id }, data: widen });
    return { signalId, eventId: existing.id, createdEvent: false };
  }

  const event = await tx.events.create({
    data: {
      title: c.locationLabel ? `${c.locationLabel}`.slice(0, TITLE_MAX) : null,
      description: c.quote,
      types: [c.hazardType],
      startedAt: c.occurredAt,
      validFrom: c.occurredAt,
      validTo: new Date(c.occurredAt.getTime() + HISTORICAL_EVENT_WINDOW_MS),
      firstSignalCreatedAt: c.occurredAt,
      lastSignalCreatedAt: c.occurredAt,
      locationId: c.locationId ?? opts.fallbackLocationId,
      rank: 0,
      signalEvents: { create: { signalId, collectedAt: opts.now } },
    },
    select: { id: true },
  });
  return { signalId, eventId: event.id, createdEvent: true };
}
