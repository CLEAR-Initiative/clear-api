import type { PrismaClient } from "../generated/prisma/client.js";
import { DEFAULT_LOCALE, type Locale } from "./locales.js";

/**
 * Per-request loader for an event's representative marker point: the
 * location of its FIRST signal. Batches by `eventId` across a resolver
 * pass so a page of N events costs two queries (events + signals), not
 * 2·N. Mirrors the microtask-batching pattern in `translation-loader.ts`
 * — no `dataloader` dependency.
 *
 * Both `Event.representativePoint` and `Alert.representativePoint` route
 * through this; the marker use case is inherently bulk (a map full of
 * events via `eventsPage` / `alertsPage`), which is exactly where a naive
 * per-field query N+1s.
 */
export interface RepresentativePointLoader {
  /** Resolve the representative point (a `locations` row) for one event,
   *  or null when the first signal has no located point / the event has
   *  no signals. Batched with sibling loads in the same microtask. */
  load(eventId: string): Promise<unknown>;
}

interface Pending {
  eventId: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export function createRepresentativePointLoader(
  prisma: PrismaClient,
  locale: Locale,
): RepresentativePointLoader {
  const queue: Pending[] = [];
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(async () => {
      scheduled = false;
      const pending = queue.splice(0);
      if (pending.length === 0) return;
      const eventIds = [...new Set(pending.map((p) => p.eventId))];
      try {
        const byEvent = await batchResolve(prisma, locale, eventIds);
        for (const p of pending) p.resolve(byEvent.get(p.eventId) ?? null);
      } catch (err) {
        for (const p of pending) p.reject(err);
      }
    });
  }

  return {
    load(eventId: string) {
      return new Promise<unknown>((resolve, reject) => {
        queue.push({ eventId, resolve, reject });
        schedule();
      });
    },
  };
}

/**
 * Resolve representative points for a batch of events in two queries.
 * Exported for unit testing — the loader wrapper only adds batching.
 */
export async function batchResolve(
  prisma: PrismaClient,
  locale: Locale,
  eventIds: readonly string[],
): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>();
  if (eventIds.length === 0) return result;

  const include = locale === DEFAULT_LOCALE
    ? undefined
    : { translations: { where: { locale } } };
  const locInclude = include ? { include } : {};

  // (1) The recorded first-signal timestamp per event — this picks the
  //     ORIGINAL first signal, stable even if an older-dated signal is
  //     attached to the event later.
  const events = await prisma.events.findMany({
    where: { id: { in: [...eventIds] } },
    select: { id: true, firstSignalCreatedAt: true },
  });
  const firstTsByEvent = new Map(
    events.map((e) => [e.id, e.firstSignalCreatedAt]),
  );

  // (2) All signals for these events, earliest first, with the join rows
  //     (so we know which of the batch events each belongs to) and the
  //     location cascade.
  const signals = await prisma.signals.findMany({
    where: { signalEvents: { some: { eventId: { in: [...eventIds] } } } },
    orderBy: { publishedAt: "asc" },
    include: {
      signalEvents: { where: { eventId: { in: [...eventIds] } }, select: { eventId: true } },
      originLocation: locInclude,
      destinationLocation: locInclude,
      generalLocation: locInclude,
    },
  });

  // Group signals per event, preserving the publishedAt-asc order. A
  // signal can belong to several of the batch events (many-to-many).
  const signalsByEvent = new Map<string, typeof signals>();
  for (const s of signals) {
    for (const se of s.signalEvents) {
      const arr = signalsByEvent.get(se.eventId);
      if (arr) arr.push(s);
      else signalsByEvent.set(se.eventId, [s]);
    }
  }

  for (const eventId of eventIds) {
    const evSignals = signalsByEvent.get(eventId);
    if (!evSignals || evSignals.length === 0) {
      result.set(eventId, null);
      continue;
    }
    const firstTs = firstTsByEvent.get(eventId);
    const firstMs = firstTs ? new Date(firstTs).getTime() : null;
    const first =
      (firstMs !== null
        ? evSignals.find((s) => s.publishedAt.getTime() === firstMs)
        : undefined) ?? evSignals[0];
    result.set(
      eventId,
      first.originLocation ?? first.destinationLocation ?? first.generalLocation ?? null,
    );
  }
  return result;
}
