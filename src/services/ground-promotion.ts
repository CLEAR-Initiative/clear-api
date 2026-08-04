/**
 * Promotion: an approved_public ground thread → the standard signals
 * graph, via the existing createSignal path (never a parallel write to
 * `signals` — promoted signals flow geoparse enrichment, event grouping
 * and alerting exactly like Dataminr/ACLED ones).
 *
 * Non-negotiable (PRD §4): ALL sender identity is scrubbed from what is
 * promoted. `senderName` and even the pseudonymous `senderRef` stay in
 * the private staging tier; the promoted rawData carries message content
 * and provenance (thread id, externalIds, timestamps, uncertainty) only.
 *
 * The mapping is pure (unit-tested with a scrub assertion); the
 * dataSources row lookup/create is the only I/O here.
 */

import type { PrismaClient } from "../generated/prisma/client.js";

/** The one dataSources row all WhatsApp-promoted signals hang off. */
export const WHATSAPP_DATA_SOURCE = {
  name: "whatsapp",
  type: "whatsapp",
} as const;

export interface PromotableMessage {
  externalId: string;
  sentAt: Date;
  /** Already phone-redacted at persistence. */
  text: string;
  mediaKeys: string[];
  omittedMediaCount: number;
  classification: string | null;
  uncertainty: string | null;
  isEdited: boolean;
  // NOTE: senderRef / senderName deliberately NOT part of this shape —
  // the type system keeps identity out of the promotion path.
}

export interface PromotedSignalInput {
  sourceId: string;
  externalId: string;
  rawData: Record<string, unknown>;
  publishedAt: string;
  title?: string;
  description?: string;
  media?: string[];
}

/**
 * Map an approved_public thread to CreateSignalInput.
 *
 * - externalId: the earliest message's "whatsapp:{groupJid}:{messageId}"
 *   — same (sourceId, externalId) dedupe scheme createSignal documents
 *   for "dataminr:{alertId}", so re-promotion is idempotent.
 * - publishedAt: earliest message timestamp (when the field reported it,
 *   not when a reviewer approved it).
 * - media: presigned URLs supplied by the caller (generated at promotion
 *   time from mediaKeys, never stored).
 * - rawData: ground marker + thread provenance + per-message content.
 */
export function buildPromotedSignalInput(options: {
  dataSourceId: string;
  thread: { id: string; title: string | null; lifecycleState: string };
  messages: PromotableMessage[];
  mediaUrls?: string[];
}): PromotedSignalInput {
  const { dataSourceId, thread, mediaUrls } = options;
  if (options.messages.length === 0) {
    throw new Error(`Cannot promote thread ${thread.id}: it has no messages`);
  }

  const messages = [...options.messages].sort(
    (a, b) => a.sentAt.getTime() - b.sentAt.getTime(),
  );
  const earliest = messages[0]!;

  const description = messages
    .map((m) => (m.text !== "" ? m.text : "[media message]"))
    .join("\n\n");

  return {
    sourceId: dataSourceId,
    externalId: earliest.externalId,
    publishedAt: earliest.sentAt.toISOString(),
    title: thread.title ?? undefined,
    description,
    ...(mediaUrls && mediaUrls.length > 0 ? { media: mediaUrls } : {}),
    rawData: {
      ground: true,
      groundThreadId: thread.id,
      lifecycleState: thread.lifecycleState,
      messageCount: messages.length,
      messages: messages.map((m) => ({
        externalId: m.externalId,
        sentAt: m.sentAt.toISOString(),
        text: m.text,
        mediaKeys: m.mediaKeys,
        omittedMediaCount: m.omittedMediaCount,
        classification: m.classification,
        uncertainty: m.uncertainty,
        isEdited: m.isEdited,
      })),
    },
  };
}

/**
 * Find-or-create the single "whatsapp" dataSources row. Created lazily on
 * first promotion; subsequent promotions reuse it.
 */
export async function ensureWhatsAppDataSource(
  prisma: Pick<PrismaClient, "dataSources">,
): Promise<{ id: string }> {
  const existing = await prisma.dataSources.findFirst({
    where: { name: WHATSAPP_DATA_SOURCE.name, type: WHATSAPP_DATA_SOURCE.type },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.dataSources.create({
    data: {
      name: WHATSAPP_DATA_SOURCE.name,
      type: WHATSAPP_DATA_SOURCE.type,
      isActive: true,
    },
    select: { id: true },
  });
}
