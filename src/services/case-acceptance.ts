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

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { resolveEventCountryId } from "../utils/event-country.js";

/** The DataSource every accepted web case is filed under (seeded by the
 *  `add_case_proposals` migration). */
export const WEB_ENRICHMENT_SOURCE = "web_enrichment";
/** How long a historical Event counts as open after its onset, the same
 *  window the pipeline gives a new Event. */
const HISTORICAL_EVENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TITLE_MAX = 200;
/** The Domain Ontology version whose metric definitions a case's figures use. */
const DEFINITION_VERSION = "0.3.0";

type Tx = Prisma.TransactionClient;

export interface CaseFigure {
  metric: string;
  value: number;
  lowerBound?: number;
  upperBound?: number;
  unit?: string;
  populationGroup?: string;
}

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
  /** Validated at proposal: ontology metrics, ordered bounds. */
  figures: unknown;
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
 * The Signal for the case's URL, written once however many deciders accept
 * a case with that URL at the same moment. `INSERT … ON CONFLICT DO
 * NOTHING` on the unique (source, externalId) makes the second writer wait
 * for the first and then read its row, instead of failing on the unique
 * index and rolling its decision back (Prisma's `upsert` is a read then a
 * write, so it would race).
 */
async function writeCaseSignal(tx: Tx, c: AcceptedCase, opts: { userId: string; now: Date }): Promise<string> {
  const sourceId = await webEnrichmentSourceId(tx);
  const externalId = `url:${createHash("sha256").update(c.sourceUrl).digest("hex")}`;
  const rawData = {
    caseProposalId: c.id,
    quote: c.quote,
    locationLabel: c.locationLabel,
    hazardType: c.hazardType,
    methodVersion: c.methodVersion,
    acceptedBy: opts.userId,
  };
  // Timestamp columns are without time zone and hold UTC, as Prisma writes them.
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "signals" (
      "id", "source_id", "external_id", "raw_data", "published_at", "collected_at",
      "status", "processed_at", "url", "description", "location_id", "submitted_by_id",
      "media", "isDummy"
    ) VALUES (
      ${`case${randomUUID().replace(/-/g, "")}`}, ${sourceId}, ${externalId}, ${JSON.stringify(rawData)}::jsonb,
      (${c.occurredAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
      (${opts.now.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
      'PROCESSED'::"SignalStatus",
      (${opts.now.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
      ${c.sourceUrl}, ${c.quote}, ${c.locationId}, ${opts.userId},
      ARRAY[]::text[], false
    )
    ON CONFLICT ("source_id", "external_id") DO NOTHING
    RETURNING "id"`;
  if (inserted.length > 0) return inserted[0].id;
  const existing = await tx.signals.findFirstOrThrow({ where: { sourceId, externalId }, select: { id: true } });
  return existing.id;
}

/**
 * Whether an Event a reused Signal already sits on is the same incident as
 * the case: it manifests the case's hazard and lies in the requesting
 * Event's country — the checks `completeTask` puts on an explicit match.
 */
async function isSameIncidentContext(
  tx: Tx,
  eventId: string,
  hazardType: string,
  countryId: string | null,
): Promise<boolean> {
  if (!countryId) return false;
  const event = await tx.events.findUnique({
    where: { id: eventId },
    select: { types: true, locationId: true, originId: true, destinationId: true },
  });
  if (!event || !event.types.includes(hazardType)) return false;
  return (await resolveEventCountryId(tx, event)) === countryId;
}

/**
 * Write one accepted case into CLEAR. Must run inside the transaction that
 * moved the case to `accepted`, so a failure here leaves it `proposed`.
 *
 * - A Signal with the same URL already in CLEAR, from any source, is reused
 *   rather than duplicated (exact-duplicate removal is the one judgement the
 *   ontology allows at ingestion) — unless the pipeline has not processed it
 *   yet (`NEW`): the drain will group that one itself, so the case gets its
 *   own `web_enrichment` Signal instead of being regrouped with it.
 * - The Event is, in order: the Worker's matched Event (checked at
 *   proposal); an Event the reused Signal already sits on, if it manifests
 *   the case's hazard in the same country; a new historical Event.
 * - Linking a Signal to an existing Event widens its first/last Signal
 *   times to cover the incident but never moves them inward, so a backdated
 *   Signal cannot make a live Event look stale.
 *
 * The case's figures become Estimates on that Event.
 *
 * The case row, not the Signal, is the audit record of the decision (who,
 * when, why, the quote): a reused Signal keeps the details it was ingested
 * with.
 */
/**
 * The case's figures as Estimates on the Event it now sits on (the Domain
 * Ontology's Estimate): method `media_report` (a figure a published source
 * states), attribution `event_caused` (a case is an incident's own toll),
 * valid for the date the incident happened. Insert-only — Estimates are
 * never updated. A figure already recorded for that Event from the same
 * source, metric and population group is not written twice.
 */
async function writeCaseEstimates(
  tx: Tx,
  c: AcceptedCase,
  target: { eventId: string; signalId: string },
  opts: { userId: string; now: Date },
): Promise<number> {
  const figures = Array.isArray(c.figures) ? (c.figures as CaseFigure[]) : [];
  let written = 0;
  for (const f of figures) {
    const populationGroup = f.populationGroup ?? null;
    const metric = f.metric as Prisma.estimateCreateManyInput["metric"];
    const already = await tx.estimate.findFirst({
      where: { eventId: target.eventId, sourceUrl: c.sourceUrl, metric, populationGroup },
      select: { id: true },
    });
    if (already) continue;
    await tx.estimate.create({
      data: {
        eventId: target.eventId,
        metric,
        populationGroup,
        value: f.value,
        unit: f.unit ?? null,
        lowerBound: f.lowerBound ?? null,
        upperBound: f.upperBound ?? null,
        method: "media_report",
        attribution: "event_caused",
        validFor: c.occurredAt,
        estimatedAt: opts.now,
        sourceSignalId: target.signalId,
        sourceUrl: c.sourceUrl,
        definitionVersion: DEFINITION_VERSION,
        createdById: opts.userId,
      },
    });
    written++;
  }
  return written;
}

export async function acceptCase(
  tx: Tx,
  c: AcceptedCase,
  opts: { userId: string; countryId: string | null; now: Date },
): Promise<AcceptanceResult> {
  const reused = await tx.signals.findFirst({
    where: { url: c.sourceUrl, status: { not: "NEW" } },
    orderBy: { publishedAt: "asc" },
    select: { id: true, signalEvents: { select: { eventId: true }, orderBy: { collectedAt: "asc" } } },
  });
  const signalId = reused ? reused.id : await writeCaseSignal(tx, c, opts);

  let existingEventId = c.matchedEventId;
  if (!existingEventId && reused) {
    for (const { eventId } of reused.signalEvents) {
      if (await isSameIncidentContext(tx, eventId, c.hazardType, opts.countryId)) {
        existingEventId = eventId;
        break;
      }
    }
  }
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
    await writeCaseEstimates(tx, c, { eventId: existing.id, signalId }, opts);
    return { signalId, eventId: existing.id, createdEvent: false };
  }

  const event = await tx.events.create({
    data: {
      title: c.locationLabel ? c.locationLabel.slice(0, TITLE_MAX) : null,
      description: c.quote,
      types: [c.hazardType],
      startedAt: c.occurredAt,
      validFrom: c.occurredAt,
      validTo: new Date(c.occurredAt.getTime() + HISTORICAL_EVENT_WINDOW_MS),
      firstSignalCreatedAt: c.occurredAt,
      lastSignalCreatedAt: c.occurredAt,
      // Without a resolved place it sits at the country, still findable by geography.
      locationId: c.locationId ?? opts.countryId,
      rank: 0,
      signalEvents: { create: { signalId, collectedAt: opts.now } },
    },
    select: { id: true },
  });
  await writeCaseEstimates(tx, c, { eventId: event.id, signalId }, opts);
  return { signalId, eventId: event.id, createdEvent: true };
}
