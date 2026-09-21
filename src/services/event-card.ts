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
import {
  EMBEDDING_DIMENSIONS,
  embedDocument,
  loadEmbeddingConfig,
  vectorLiteral,
} from "../utils/embedding-client.js";

/** Minimal event shape the card needs — matches a `prisma.events.findMany`
 *  with the three location relations selected. */
export interface EventForCard {
  id: string;
  title: string | null;
  description: string | null;
  /** Per-signal descriptions the grouping recorded (JSON). Folded into the
   *  card so a report-less incident still has retrievable body text (E13). */
  description_signals: unknown;
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

/** Pull human-readable text out of the `description_signals` JSON (E13). The
 *  grouping stores a list of per-signal descriptions (strings, or objects with a
 *  `description`/`text`/`title` field); be defensive about the exact shape. */
function signalTexts(descriptionSignals: unknown): string[] {
  if (!Array.isArray(descriptionSignals)) return [];
  const out: string[] = [];
  for (const s of descriptionSignals) {
    if (typeof s === "string" && s.trim()) out.push(s.trim());
    else if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      const t = o.description ?? o.text ?? o.title;
      if (typeof t === "string" && t.trim()) out.push(t.trim());
    }
  }
  return out;
}

/** A truly content-less event (no title, description, signal text, type,
 *  location, or metric) would embed the bare token "Incident" → a garbage vector
 *  that matches unrelated queries. Skip those (reviewer E6). */
export function isContentEmpty(ev: EventForCard): boolean {
  return !ev.title?.trim()
    && !ev.description?.trim()
    && signalTexts(ev.description_signals).length === 0
    && ev.types.length === 0
    && distinctLocations(ev).names.length === 0
    && ev.severity == null && ev.casualties == null
    && ev.populationDisplaced == null && ev.populationAffected == null;
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

  // Body: the event description, else the per-signal descriptions (E13).
  const description = ev.description?.trim() || signalTexts(ev.description_signals).join(" ");
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

const EVENT_SELECT = {
  id: true, title: true, description: true, description_signals: true, types: true,
  severity: true, casualties: true, populationDisplaced: true, populationAffected: true,
  startedAt: true, firstSignalCreatedAt: true, validFrom: true, validTo: true,
  originLocation: { select: { id: true, name: true } },
  destinationLocation: { select: { id: true, name: true } },
  generalLocation: { select: { id: true, name: true } },
} as const;

/**
 * Synthesise + embed + upsert cards for the given events into `events_index`
 * (replace-on-revise, keyed by event_id). Returns {synced, skipped}: `synced` =
 * cards written; `skipped` = every other id (unresolved event, content-empty
 * event, or a per-event embed/write failure). Each event is isolated (reviewer
 * E4) — one failure never aborts the batch or loses the count — and each upsert
 * is idempotent, so a re-run is safe. Embedding is one call per event (cheap).
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
  let failed = 0;
  for (const ev of events) {
    if (isContentEmpty(ev)) continue; // E6 — no body to embed; counted in skipped
    try {
      await upsertOneCard(prisma, config, ev);
      synced += 1;
    } catch (err) {
      // Per-event isolation (E4): drop just this card and continue. Earlier cards
      // are already committed (each is an idempotent upsert), so the batch never
      // aborts mid-way with a partial, uncounted result.
      failed += 1;
      console.error(
        `[syncEventCards] event ${ev.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (failed > 0) {
    console.warn(`[syncEventCards] ${failed} of ${events.length} events failed to sync`);
  }
  return { synced, skipped: eventIds.length - synced };
}

async function upsertOneCard(
  prisma: Context["prisma"],
  config: { provider: string; model: string },
  ev: EventForCard,
): Promise<void> {
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
}
