/**
 * Briefs: the domain rules that sit under `brief.resolver.ts`.
 *
 * A Brief covers one area over one Brief window. Its items point at Alerts,
 * Events and Signals by id and carry a snapshot of what the Brief shows, built
 * here from live data and never from client input.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import type { BriefCadence, BriefItemKind } from "../generated/prisma/enums.js";
import { env } from "../utils/env.js";
import type { BriefEmailView } from "./messaging/templates.js";

/** Item groups in the order a Brief shows them. */
export const BRIEF_KIND_ORDER: readonly BriefItemKind[] = ["alert", "event", "signal"];

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS: Record<BriefCadence, number> = {
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
  monthly: 30 * 24 * HOUR_MS,
};

const CADENCE_LABEL: Record<BriefCadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/** The Brief window ending at `end`: the last 24 hours, 7 days or 30 days. */
export function briefWindow(
  cadence: BriefCadence,
  end: Date = new Date(),
): { windowStart: Date; windowEnd: Date } {
  return { windowStart: new Date(end.getTime() - WINDOW_MS[cadence]), windowEnd: end };
}

/** "Daily Brief, Sudan". */
export function defaultBriefTitle(cadence: BriefCadence, locationName: string): string {
  return `${CADENCE_LABEL[cadence]} Brief, ${locationName}`;
}

/** What a picked item shows. Stored as `brief_items.snapshot`. */
export interface BriefItemSnapshot {
  title: string;
  severity: number | null;
  locationName: string | null;
  eventTypes: string[];
  /** ISO time the item is windowed on: an Alert's or Event's first Signal,
   *  a Signal's publication. Same columns as `entityStats`. */
  occurredAt: string;
  /** clear-mvp page for the item: `/event/<id>` (Alerts use their Event)
   *  or `/signal/<id>`. */
  url: string;
}

const UNTITLED = "Untitled";

function frontendUrl(path: string): string {
  return `${env.FRONTEND_URL.replace(/\/$/, "")}${path}`;
}

const LOCATION_SELECT = { select: { name: true } } as const;
const EVENT_SNAPSHOT_SELECT = {
  id: true,
  title: true,
  severity: true,
  types: true,
  firstSignalCreatedAt: true,
  generalLocation: LOCATION_SELECT,
  originLocation: LOCATION_SELECT,
  destinationLocation: LOCATION_SELECT,
} as const;

type LocatedRow = {
  generalLocation: { name: string } | null;
  originLocation: { name: string } | null;
  destinationLocation: { name: string } | null;
};

function locationNameOf(row: LocatedRow): string | null {
  return (
    row.generalLocation?.name ?? row.originLocation?.name ?? row.destinationLocation?.name ?? null
  );
}

type EventRow = LocatedRow & {
  id: string;
  title: string | null;
  severity: number | null;
  types: string[];
  firstSignalCreatedAt: Date;
};

function eventSnapshot(event: EventRow): BriefItemSnapshot {
  return {
    title: event.title?.trim() || UNTITLED,
    severity: event.severity,
    locationName: locationNameOf(event),
    eventTypes: event.types,
    occurredAt: event.firstSignalCreatedAt.toISOString(),
    url: frontendUrl(`/event/${event.id}`),
  };
}

/**
 * Build an item's snapshot from the live row. Returns null when the entity
 * no longer exists (the pipeline merges and deletes them).
 */
export async function buildBriefItemSnapshot(
  prisma: PrismaClient,
  kind: BriefItemKind,
  entityId: string,
): Promise<BriefItemSnapshot | null> {
  if (kind === "alert") {
    const alert = await prisma.alerts.findUnique({
      where: { id: entityId },
      select: { event: { select: EVENT_SNAPSHOT_SELECT } },
    });
    return alert ? eventSnapshot(alert.event) : null;
  }
  if (kind === "event") {
    const event = await prisma.events.findUnique({
      where: { id: entityId },
      select: EVENT_SNAPSHOT_SELECT,
    });
    return event ? eventSnapshot(event) : null;
  }
  const signal = await prisma.signals.findUnique({
    where: { id: entityId },
    select: {
      id: true,
      title: true,
      severity: true,
      publishedAt: true,
      generalLocation: LOCATION_SELECT,
      originLocation: LOCATION_SELECT,
      destinationLocation: LOCATION_SELECT,
      signalEvents: { select: { event: { select: { types: true } } } },
    },
  });
  if (!signal) return null;
  // A Signal has no disaster type of its own: it takes its Events' types.
  const eventTypes = [...new Set(signal.signalEvents.flatMap((se) => se.event.types))];
  return {
    title: signal.title?.trim() || UNTITLED,
    severity: signal.severity,
    locationName: locationNameOf(signal),
    eventTypes,
    occurredAt: signal.publishedAt.toISOString(),
    url: frontendUrl(`/signal/${signal.id}`),
  };
}

/** Items ordered as the Brief shows them: by group, then position. */
export function orderBriefItems<T extends { kind: BriefItemKind; position: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      BRIEF_KIND_ORDER.indexOf(a.kind) - BRIEF_KIND_ORDER.indexOf(b.kind) ||
      a.position - b.position,
  );
}

type BriefForEmail = {
  title: string;
  locationName: string;
  windowStart: Date;
  windowEnd: Date;
};

type ItemForEmail = {
  kind: BriefItemKind;
  position: number;
  note: string | null;
  snapshot: unknown;
};

/** A Brief and its items as the email template renders them. */
export function toBriefEmailView(brief: BriefForEmail, items: readonly ItemForEmail[]): BriefEmailView {
  const ordered = orderBriefItems(items);
  return {
    title: brief.title,
    locationName: brief.locationName,
    windowStart: brief.windowStart,
    windowEnd: brief.windowEnd,
    groups: BRIEF_KIND_ORDER.map((kind) => ({
      kind,
      items: ordered
        .filter((item) => item.kind === kind)
        .map((item) => ({ ...(item.snapshot as BriefItemSnapshot), note: item.note })),
    })),
  };
}
