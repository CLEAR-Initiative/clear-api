import type { PrismaClient } from "../generated/prisma/client.js";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type Locale,
} from "./locales.js";

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
  /**
   * Location id of the resolved row — needed so the per-recipient
   * alert path can fetch a translated name for it. Always set; the
   * caller chains a name-localization step on top.
   */
  id: string;
  name: string;
  population: bigint | null;
}

/**
 * Per-locale localized title + description for a single event. Returned
 * by `fetchEventLocalizedText`; each key is a recipient locale and the
 * value carries the strings that should appear in their notification.
 * Locales that have no translation row fall back to canonical English
 * silently — the caller doesn't need to branch on "did it exist".
 */
export type EventLocalizedText = Map<
  Locale,
  { title: string | null; description: string | null }
>;

/**
 * Fetch the title + description of one event for every recipient
 * locale in `locales`, in a single Prisma query.
 *
 * Why this exists: alert notification paths (createAlert, escalateEvent,
 * notification.publishAlert) read `event.title` / `event.description`
 * straight from the canonical Prisma row, so every recipient gets
 * English regardless of `user.language`. The GraphQL resolver overlay
 * doesn't run here — it's outside the request response path. This
 * helper closes that gap.
 *
 * Behaviour:
 *   - The `en` entry is always present and points at the canonical
 *     strings (no DB hit needed).
 *   - For every other locale in `locales`, the translation row's
 *     `data.title` / `data.description` win when present, otherwise
 *     we fall back to the canonical strings so a missing translation
 *     never produces an empty notification.
 *   - Locales not in `locales` aren't in the returned map — callers
 *     should normalise unknown user.languages to a supported locale
 *     before passing them in, using `normaliseUserLocale` below.
 */
export async function fetchEventLocalizedText(
  prisma: PrismaClient,
  eventId: string,
  canonicalTitle: string | null,
  canonicalDescription: string | null,
  locales: Iterable<Locale>,
): Promise<EventLocalizedText> {
  const out: EventLocalizedText = new Map();
  // Canonical English is always available — no query needed.
  out.set(DEFAULT_LOCALE, {
    title: canonicalTitle,
    description: canonicalDescription,
  });

  const nonEn = [...new Set(locales)].filter((l) => l !== DEFAULT_LOCALE);
  if (nonEn.length === 0) return out;

  const rows = await prisma.translations.findMany({
    where: {
      entityType: "event",
      entityId: eventId,
      locale: { in: nonEn },
    },
    select: { locale: true, data: true },
  });

  // Index translated rows by locale.
  const byLocale = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    byLocale.set(row.locale, (row.data ?? {}) as Record<string, unknown>);
  }

  // Populate every requested locale; missing rows fall back to canonical.
  for (const locale of nonEn) {
    const data = byLocale.get(locale);
    out.set(locale, {
      title:
        typeof data?.title === "string" ? data.title : canonicalTitle,
      description:
        typeof data?.description === "string"
          ? data.description
          : canonicalDescription,
    });
  }
  return out;
}

/**
 * Normalise a raw `user.language` string (which is whatever the user
 * stored on their profile — possibly stale, unsupported, or null) to
 * a Locale we know how to translate to. Unknown / null / "en" values
 * collapse to DEFAULT_LOCALE so the per-recipient loop doesn't have
 * to special-case them.
 */
export function normaliseUserLocale(raw: string | null | undefined): Locale {
  return isSupportedLocale(raw) ? raw : DEFAULT_LOCALE;
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
    return { id: loc.id, name: loc.name, population: loc.population };
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
    if (found) return { id: found.id, name: found.name, population: found.population };
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
  id: string;
  name: string;
  level: number;
  pointType: string | null;
  ancestorIds: string[];
}

/**
 * Mirror of the frontend `resolveLocationName` (clear-mvp/src/lib/location.ts):
 *   1. `landmark-geocoded` L4 → use its own row.
 *   2. Level ≤ 2 (admin polygon) → use its own row.
 *   3. Otherwise (deep level with non-landmark provenance — typically a
 *      coord-derived point whose `name` is the raw signal title) → fall
 *      back to the nearest L≤2 ancestor, preferring the most specific
 *      (highest level).
 *
 * Returns `{ id, name }` so callers can swap in a translated name later
 * (the id is what `localizeLocationNames` keys on).
 */
function resolveSignalLocation(
  loc: SignalLocCandidate,
  ancestorById: Map<string, { id: string; name: string; level: number }>,
): { id: string; name: string } | null {
  if (loc.pointType === "landmark-geocoded") return { id: loc.id, name: loc.name };
  if (loc.level <= 2) return { id: loc.id, name: loc.name };
  let best: { id: string; name: string; level: number } | null = null;
  for (const aid of loc.ancestorIds ?? []) {
    const a = ancestorById.get(aid);
    if (!a || a.level > 2) continue;
    if (!best || a.level > best.level) best = a;
  }
  return best ? { id: best.id, name: best.name } : null;
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
): Promise<{ ids: string[]; names: string[]; overflow: number }> {
  const locSelect = {
    select: {
      id: true,
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

  // One batched lookup for ancestor rows — many signals share ancestors,
  // so deduping the ids first avoids N+1 queries.
  const ancestors =
    ancestorIdsNeeded.size > 0
      ? await prisma.locations.findMany({
          where: { id: { in: [...ancestorIdsNeeded] } },
          select: { id: true, name: true, level: true },
        })
      : [];
  const ancestorById = new Map(
    ancestors.map((a) => [a.id, { id: a.id, name: a.name, level: a.level }]),
  );

  // Second pass: resolve each candidate to a (id, name) pair, dedupe
  // by id (not by name — two different locations can share a name),
  // and cap.
  const seenIds = new Set<string>();
  const resolved: Array<{ id: string; name: string }> = [];
  for (const loc of candidates) {
    const r = resolveSignalLocation(loc, ancestorById);
    if (!r) continue;
    if (seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    resolved.push(r);
  }

  const overflow = Math.max(0, resolved.length - MAX_SIGNAL_LOCATIONS);
  const capped = resolved.slice(0, MAX_SIGNAL_LOCATIONS);
  return {
    ids: capped.map((c) => c.id),
    names: capped.map((c) => c.name),
    overflow,
  };
}

/**
 * Batched localized-name lookup for the `translations` sidecar.
 *
 * Given a set of location ids and a set of recipient locales, returns
 * a nested map keyed first by location id, then by locale, with the
 * translated name as the value. Locations / locales with no
 * translation row are simply absent — callers chain `?? canonical` to
 * fall back to canonical English.
 *
 * One Prisma query covers every (id, locale) pair, so a notification
 * batch touching 8 locations and 3 locales fires one query rather
 * than 24.
 */
export async function localizeLocationNames(
  prisma: PrismaClient,
  locationIds: Iterable<string>,
  locales: Iterable<Locale>,
): Promise<Map<string, Map<Locale, string>>> {
  const idList = [...new Set(locationIds)];
  // Canonical English doesn't live in the sidecar — skip it.
  const localeList = [...new Set(locales)].filter((l) => l !== DEFAULT_LOCALE);
  if (idList.length === 0 || localeList.length === 0) return new Map();

  const rows = await prisma.translations.findMany({
    where: {
      entityType: "location",
      entityId: { in: idList },
      locale: { in: localeList },
    },
    select: { entityId: true, locale: true, data: true },
  });

  const out = new Map<string, Map<Locale, string>>();
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const name = typeof data.name === "string" ? data.name : null;
    if (!name) continue;
    let inner = out.get(row.entityId);
    if (!inner) {
      inner = new Map();
      out.set(row.entityId, inner);
    }
    inner.set(row.locale as Locale, name);
  }
  return out;
}

/**
 * Pick the translated name for one (locationId, locale) pair, falling
 * back to the canonical name if no translation row exists. Tiny
 * convenience around the map returned by `localizeLocationNames`.
 */
export function pickLocalizedName(
  cache: Map<string, Map<Locale, string>>,
  locationId: string | null | undefined,
  locale: Locale,
  canonical: string | null,
): string | null {
  if (!locationId) return canonical;
  return cache.get(locationId)?.get(locale) ?? canonical;
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
