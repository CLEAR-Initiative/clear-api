/**
 * Event-card write path for the incident tier of the knowledgebase (ADR-0006).
 *
 * An event (grouped signals) is turned into a short synthesised "event card",
 * embedded with the SAME provider+model as the report KB (document head), and
 * upserted into `events_index` (replace-on-revise, keyed by `event_id`). This is
 * the incident-tier analog of the pipeline's report-chunk ingest.
 *
 * `synthesiseEventCard` is a pure function (unit-testable without a DB or the
 * embedding provider); `syncEventCards` loads events, embeds, and writes.
 */

import type { Context } from "../context.js";
import { embedDocument, loadEmbeddingConfig } from "../utils/embedding-client.js";

const EMBEDDING_DIMENSIONS = 1024;

/** Minimal event shape the card needs — matches a `prisma.events.findMany`
 *  with the three location relations selected. */
export interface EventForCard {
  id: string;
  title: string | null;
  description: string | null;
  types: string[];
  severity: number | null;
  casualties: number | null;
  populationDisplaced: bigint | null;
  populationAffected: bigint | null;
  startedAt: Date | null;
  firstSignalCreatedAt: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  originLocation: { id: string; name: string | null } | null;
  destinationLocation: { id: string; name: string | null } | null;
  generalLocation: { id: string; name: string | null } | null;
}

export interface EventCard {
  eventId: string;
  title: string;
  /** Human-readable card a UI renders on a search hit. */
  cardText: string;
  /** What gets embedded + tokenised (title + card + structured line). */
  embeddedText: string;
  locationIds: string[];
  locationPcodes: string[];
  timeRangeStart: Date | null;
  timeRangeEnd: Date | null;
  startedAt: Date | null;
  eventTypes: string[];
  severity: number | null;
  sourceUrl: string | null;
}

function distinctLocations(ev: EventForCard): { ids: string[]; names: string[] } {
  const ids: string[] = [];
  const names: string[] = [];
  for (const loc of [ev.originLocation, ev.destinationLocation, ev.generalLocation]) {
    if (loc && !ids.includes(loc.id)) {
      ids.push(loc.id);
      if (loc.name) names.push(loc.name);
    }
  }
  return { ids, names };
}

/** Build the event card. Pure — no DB, no network. */
export function synthesiseEventCard(ev: EventForCard): EventCard {
  const { ids: locationIds, names: locationNames } = distinctLocations(ev);
  const onset = ev.startedAt ?? ev.firstSignalCreatedAt ?? null;

  const title = (ev.title?.trim())
    || `${ev.types.join(" / ") || "Incident"}${locationNames[0] ? ` — ${locationNames[0]}` : ""}`;

  // Structured line — the facts a retrieval query might match on, in a stable
  // shape. Only include the parts the event actually has.
  const facts: string[] = [];
  if (ev.types.length) facts.push(`Type: ${ev.types.join(", ")}`);
  if (locationNames.length) facts.push(`Location: ${locationNames.join(", ")}`);
  if (onset) facts.push(`Onset: ${onset.toISOString().slice(0, 10)}`);
  if (ev.severity != null) facts.push(`Severity: ${ev.severity}/5`);
  if (ev.casualties != null) facts.push(`Casualties: ${ev.casualties}`);
  if (ev.populationDisplaced != null) facts.push(`Displaced: ${ev.populationDisplaced.toString()}`);
  if (ev.populationAffected != null) facts.push(`Affected: ${ev.populationAffected.toString()}`);
  const structuredLine = facts.join(". ");

  const description = ev.description?.trim() ?? "";
  const cardText = [description, structuredLine].filter(Boolean).join("\n\n");
  const embeddedText = [title, cardText].filter(Boolean).join("\n\n");

  return {
    eventId: ev.id,
    title,
    cardText: cardText || title,
    embeddedText,
    locationIds,
    locationPcodes: [],
    timeRangeStart: ev.validFrom ?? onset,
    timeRangeEnd: ev.validTo ?? null,
    startedAt: onset,
    eventTypes: ev.types,
    severity: ev.severity,
    sourceUrl: null,
  };
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.map((v) => v.toFixed(7)).join(",")}]`;
}

const EVENT_SELECT = {
  id: true, title: true, description: true, types: true, severity: true,
  casualties: true, populationDisplaced: true, populationAffected: true,
  startedAt: true, firstSignalCreatedAt: true, validFrom: true, validTo: true,
  originLocation: { select: { id: true, name: true } },
  destinationLocation: { select: { id: true, name: true } },
  generalLocation: { select: { id: true, name: true } },
} as const;

/**
 * Synthesise + embed + upsert cards for the given events into `events_index`
 * (replace-on-revise, keyed by event_id). Returns how many were written vs
 * skipped (an id that no longer resolves to an event). Embedding is one call
 * per event — cheap; a card is one short string.
 */
export async function syncEventCards(
  prisma: Context["prisma"],
  eventIds: string[],
): Promise<{ synced: number; skipped: number }> {
  if (eventIds.length === 0) return { synced: 0, skipped: 0 };

  const events = (await prisma.events.findMany({
    where: { id: { in: eventIds } },
    select: EVENT_SELECT,
  })) as unknown as EventForCard[];

  const config = loadEmbeddingConfig();
  let synced = 0;
  for (const ev of events) {
    const card = synthesiseEventCard(ev);
    const embedding = await embedDocument(card.embeddedText);
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Event ${ev.id} embedding length ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO "events_index" (
          "id", "event_id", "title", "card_text", "embedded_text", "source_url",
          "embedding_provider", "embedding_model", "embedding",
          "location_ids", "location_pcodes",
          "time_range_start", "time_range_end", "started_at",
          "event_types", "severity"
        ) VALUES (
          gen_random_uuid()::text, $1, $2, $3, $4, $5,
          $6, $7, $8::vector(1024),
          $9::text[], $10::text[],
          $11, $12, $13,
          $14::text[], $15
        )
        ON CONFLICT ("event_id") DO UPDATE SET
          "title" = EXCLUDED."title",
          "card_text" = EXCLUDED."card_text",
          "embedded_text" = EXCLUDED."embedded_text",
          "source_url" = EXCLUDED."source_url",
          "embedding_provider" = EXCLUDED."embedding_provider",
          "embedding_model" = EXCLUDED."embedding_model",
          "embedding" = EXCLUDED."embedding",
          "location_ids" = EXCLUDED."location_ids",
          "location_pcodes" = EXCLUDED."location_pcodes",
          "time_range_start" = EXCLUDED."time_range_start",
          "time_range_end" = EXCLUDED."time_range_end",
          "started_at" = EXCLUDED."started_at",
          "event_types" = EXCLUDED."event_types",
          "severity" = EXCLUDED."severity"
      `,
      card.eventId, card.title, card.cardText, card.embeddedText, card.sourceUrl,
      config.provider, config.model, vectorLiteral(embedding),
      card.locationIds, card.locationPcodes,
      card.timeRangeStart, card.timeRangeEnd, card.startedAt,
      card.eventTypes, card.severity,
    );
    synced += 1;
  }
  return { synced, skipped: eventIds.length - synced };
}
