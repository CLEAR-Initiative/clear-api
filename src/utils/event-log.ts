/**
 * One structured log line per event create/update, shipped to OpenObserve by
 * Vector (clear-infra). Feeds the "latest events and merged signals" dashboard
 * panel; logs only, never throws.
 */

import { logger } from "./logger.js";

/** Cap so a huge merge cannot produce an oversized log line. */
const MAX_SIGNAL_IDS = 50;

export type EventChange = "created" | "updated" | "aggregates";

export function logEventChange(
  change: EventChange,
  event: { id: string; title?: string | null; types?: string[] | null; severity?: number | null },
  signalIds: string[] = [],
  signalCount: number = signalIds.length,
): void {
  logger.info(
    {
      module: "events",
      eventId: event.id,
      eventTitle: event.title ?? undefined,
      eventTypes: event.types ?? undefined,
      severity: event.severity ?? undefined,
      signalCount,
      signalIds: signalIds.slice(0, MAX_SIGNAL_IDS),
    },
    `event.${change}`,
  );
}
