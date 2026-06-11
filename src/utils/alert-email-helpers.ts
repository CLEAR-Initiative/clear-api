import type { PrismaClient } from "../generated/prisma/client.js";

export function severityToLabel(severity: number | null | undefined): string | null {
  const labels: Record<number, string> = {
    1: "MINIMAL",
    2: "LOW",
    3: "MEDIUM",
    4: "HIGH",
    5: "CRITICAL",
  };
  return severity != null ? (labels[severity] ?? null) : null;
}

export function formatCount(n: bigint | number): string {
  const v = typeof n === "bigint" ? Number(n) : n;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toLocaleString();
}

export interface EmailLocation {
  name: string;
  population: bigint | null;
}

/**
 * Resolve the best human-readable location for email display.
 * Prefers A2 (district) -> A1 (state) -> A0 (country).
 * Falls back through ancestors when the primary location is a point/deep level
 * (level > 2) or has a garbage name (raw signal text, > 80 chars).
 */
export async function resolveEmailLocation(
  prisma: PrismaClient,
  loc: {
    id: string;
    name: string;
    level: number;
    population: bigint | null;
    ancestorIds: string[];
  } | null,
): Promise<EmailLocation | null> {
  if (!loc) return null;

  // Admin levels 0-2 with a reasonable name - use directly.
  if (loc.level <= 2 && loc.name.length <= 80) {
    return { name: loc.name, population: loc.population };
  }

  // Point / deep-level location or garbage name - walk up to A2 -> A1 -> A0.
  if (loc.ancestorIds.length === 0) {
    // No ancestors - nothing better to show.
    return null;
  }

  const ancestors = await prisma.locations.findMany({
    where: { id: { in: loc.ancestorIds } },
    select: { id: true, name: true, level: true, population: true },
  });

  for (const targetLevel of [2, 1, 0]) {
    const found = ancestors.find((a) => a.level === targetLevel);
    if (found) return { name: found.name, population: found.population };
  }

  return null;
}

/**
 * Cap the number of signal location names rendered in the email so a
 * 50-signal event doesn't produce an unreadable wall of text. Anything
 * past the cap is collapsed into a "+N more" suffix.
 */
const MAX_SIGNAL_LOCATIONS = 3;

interface SignalLocCandidate {
  name: string;
  level: number;
  pointType: string | null;
  ancestorIds: string[];
}

/**
 * Mirror of the frontend `resolveLocationName` (clear-mvp/src/lib/location.ts):
 *   1. `landmark-geocoded` L4 → use its own name (geoparser resolved it).
 *   2. Level ≤ 2 (admin polygon) → use its own name.
 *   3. Otherwise (deep level with non-landmark provenance — typically a
 *      coord-derived point whose `name` is the raw signal title) → fall
 *      back to the nearest L≤2 ancestor, preferring the most specific
 *      (highest level).
 */
function resolveSignalLocationName(
  loc: SignalLocCandidate,
  ancestorById: Map<string, { name: string; level: number }>,
): string | null {
  if (loc.pointType === "landmark-geocoded") return loc.name;
  if (loc.level <= 2) return loc.name;
  let best: { name: string; level: number } | null = null;
  for (const id of loc.ancestorIds ?? []) {
    const a = ancestorById.get(id);
    if (!a || a.level > 2) continue;
    if (!best || a.level > best.level) best = a;
  }
  return best?.name ?? null;
}

/**
 * Deduplicated names of the locations attached to every signal linked to
 * the given event, resolved with the same rule the Signals tab uses on
 * the frontend. Per-signal we prefer `generalLocation` then `origin` then
 * `destination` — same precedence as `resolveLocationName` in clear-mvp.
 *
 * Returns at most MAX_SIGNAL_LOCATIONS names; `overflow` is the number of
 * additional distinct names dropped from the cap.
 */
export async function fetchEventSignalLocations(
  prisma: PrismaClient,
  eventId: string,
): Promise<{ names: string[]; overflow: number }> {
  const locSelect = {
    select: {
      name: true,
      level: true,
      pointType: true,
      ancestorIds: true,
    },
  } as const;

  const links = await prisma.signalEvents.findMany({
    where: { eventId },
    select: {
      signal: {
        select: {
          generalLocation: locSelect,
          originLocation: locSelect,
          destinationLocation: locSelect,
        },
      },
    },
  });

  // First pass: pick each signal's candidate location and collect the
  // ancestor ids we'll need to look up for deep / non-landmark rows.
  const candidates: SignalLocCandidate[] = [];
  const ancestorIdsNeeded = new Set<string>();
  for (const link of links) {
    const s = link.signal;
    const loc = s.generalLocation ?? s.originLocation ?? s.destinationLocation;
    if (!loc) continue;
    candidates.push(loc);
    if (loc.pointType !== "landmark-geocoded" && loc.level > 2) {
      for (const aid of loc.ancestorIds ?? []) ancestorIdsNeeded.add(aid);
    }
  }

  // One batched lookup for ancestor names — many signals share ancestors,
  // so deduping the ids first avoids N+1 queries.
  const ancestors =
    ancestorIdsNeeded.size > 0
      ? await prisma.locations.findMany({
          where: { id: { in: [...ancestorIdsNeeded] } },
          select: { id: true, name: true, level: true },
        })
      : [];
  const ancestorById = new Map(ancestors.map((a) => [a.id, { name: a.name, level: a.level }]));

  // Second pass: resolve each candidate's display name with frontend rules,
  // dedupe, and cap.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const loc of candidates) {
    const name = resolveSignalLocationName(loc, ancestorById);
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  const overflow = Math.max(0, names.length - MAX_SIGNAL_LOCATIONS);
  return { names: names.slice(0, MAX_SIGNAL_LOCATIONS), overflow };
}

/**
 * Resolve the event type label from the disasterTypes table.
 * Tries a case-insensitive glideNumber match; falls back to the raw type code.
 */
export async function resolveEventTypeLabel(
  prisma: PrismaClient,
  types: string[],
): Promise<string | null> {
  const code = types[0];
  if (!code) return null;

  const disasterType = await prisma.disasterTypes.findFirst({
    where: { glideNumber: { equals: code, mode: "insensitive" } },
    select: { level1: true },
  });

  return disasterType?.level1 ?? code;
}
