import type { PrismaClient } from "../generated/prisma/client.js";
import type { Locale } from "./locales.js";

/**
 * Discriminator written to `translations.entity_type`. Add a new value
 * here when a new model becomes translatable — the loader and resolvers
 * fan out automatically.
 */
export type TranslatableEntityType = "event" | "crisis" | "location";

/**
 * Shape stored in `translations.data`. Mirrors the canonical entity's
 * JSON shape per locale (e.g. for a crisis it carries `title`, `summary`,
 * `scenarios`, `needs` with the same nesting the API returns in English).
 * Untyped at this level so each resolver can narrow as it overlays —
 * the actual shape is enforced by the pipeline at write time.
 */
export type TranslationData = Record<string, unknown>;

/**
 * Per-request loader: batches translation lookups so a list view that
 * resolves localized fields for N entities fires one Prisma query per
 * entity_type instead of N.
 *
 * `load("crisis", id)` resolves to the row's `data` blob for the active
 * locale, or `null` if no translation has been written. Resolvers
 * COALESCE the result back to the canonical row when null.
 *
 * The loader is bound to a single locale at construction; switching
 * locale within a request isn't supported and shouldn't happen — locale
 * is derived once in `createContext`.
 */
export interface TranslationLoader {
  load(
    entityType: TranslatableEntityType,
    entityId: string,
  ): Promise<TranslationData | null>;
}

interface PendingRequest {
  entityId: string;
  resolve: (value: TranslationData | null) => void;
  reject: (error: unknown) => void;
}

/**
 * Optional hook invoked once per (entityType, entityId) pair that the
 * loader couldn't find a translation for during this request. Used by
 * `createContext` to fire-and-forget enqueue requests at
 * clear-pipeline's `/api/translate` so the next read of the same
 * entity has translations available.
 *
 * Deduplicated inside the loader: even if 10 field resolvers ask for
 * the same crisis, the callback fires exactly once per (type, id).
 */
export type OnMissingTranslation = (
  entityType: TranslatableEntityType,
  entityId: string,
) => void;

/**
 * Build a translation loader scoped to one (prisma, locale) pair. Created
 * fresh per request inside `createContext`. The canonical locale ("en")
 * short-circuits to a no-op loader so callers don't need to special-case
 * it — every `load()` returns null and the resolver falls through to the
 * canonical column without ever hitting the DB.
 *
 * `onMissing` (optional) fires once per (entityType, entityId) for any
 * entity whose translation row is absent for the active locale. The
 * caller decides what to do with the signal — typically: enqueue a
 * translation task and return.
 */
export function createTranslationLoader(
  prisma: PrismaClient,
  locale: Locale,
  onMissing?: OnMissingTranslation,
): TranslationLoader {
  if (locale === "en") {
    return {
      load: () => Promise.resolve(null),
    };
  }

  // Dedupe set for the miss callback — a single (type, id) pair fires
  // the hook at most once per request, no matter how many field
  // resolvers asked for it.
  const reportedMisses = new Set<string>();

  // One queue per entity_type. Each queue drains as a single Prisma call
  // per microtask, which is the standard DataLoader pattern — the
  // microtask boundary maps to "one resolver pass over a list of N
  // parents", so we end up with O(entity_types) queries, not O(N).
  const queues = new Map<TranslatableEntityType, PendingRequest[]>();

  function scheduleFlush(entityType: TranslatableEntityType) {
    queueMicrotask(async () => {
      const pending = queues.get(entityType);
      if (!pending || pending.length === 0) return;
      queues.delete(entityType); // drop the entry so a later-tick load starts a fresh batch

      // Dedupe ids before hitting Postgres — multiple resolvers asking
      // for the same entity (e.g. Event.title + Event.description on the
      // same row) collapse into one DB read.
      const uniqueIds = [...new Set(pending.map((p) => p.entityId))];

      try {
        // Query via the typed FK column matching this entity type
        // (event_id / crisis_id / location_id) instead of the
        // polymorphic (entity_type, entity_id) pair. Hits the
        // dedicated per-FK unique index (translations_<X>_id_locale_key)
        // and lets Prisma's planner reason about the typed relation.
        // The polymorphic columns stay populated as a fallback by
        // upsertTranslations, but reads go through the typed path.
        const fkColumn =
          entityType === "event"
            ? "eventId"
            : entityType === "crisis"
              ? "crisisId"
              : "locationId";
        const rows = await prisma.translations.findMany({
          where: {
            [fkColumn]: { in: uniqueIds },
            locale,
          },
          select: { eventId: true, crisisId: true, locationId: true, data: true },
        });

        const byId = new Map<string, TranslationData>();
        for (const row of rows) {
          // Pull whichever typed FK column matches this entity type —
          // exactly one is populated per row (enforced by the CHECK
          // constraint added in 20260617150000_add_translation_entity_relations).
          const id =
            entityType === "event"
              ? row.eventId
              : entityType === "crisis"
                ? row.crisisId
                : row.locationId;
          if (!id) continue;
          // Prisma types `data` as JsonValue which is wider than what we
          // know the pipeline writes. Cast at the loader boundary so
          // resolvers see the narrower TranslationData consistently.
          byId.set(id, row.data as TranslationData);
        }

        // Visibility for the lazy-enqueue path: when a batch is partly or
        // fully missing, the next thing in the logs is N
        // translate_entity_task enqueues. Without this line you can't
        // tell whether the pipeline is failing to persist (same misses
        // every refresh) vs. a cold list view (different misses each
        // refresh). Logs requested/found/missing rather than the full
        // miss list to keep the line short for high-cardinality batches.
        if (rows.length < uniqueIds.length) {
          console.log(
            `[translation-loader] locale=${locale} entityType=${entityType} requested=${uniqueIds.length} found=${rows.length} missing=${uniqueIds.length - rows.length}`,
          );
        }

        for (const req of pending) {
          const value = byId.get(req.entityId) ?? null;
          if (value === null && onMissing) {
            // Fire the miss hook for each unseen (type, id). Wrapped
            // in try/catch so a misbehaving hook can't poison the
            // batch's resolvers.
            const key = `${entityType}:${req.entityId}`;
            if (!reportedMisses.has(key)) {
              reportedMisses.add(key);
              try {
                onMissing(entityType, req.entityId);
              } catch {
                // Swallow — caller is responsible for its own errors.
              }
            }
          }
          req.resolve(value);
        }
      } catch (err) {
        // One failed batch shouldn't crash N parallel resolvers; surface
        // the error to each waiter and let the resolver fall through to
        // its canonical column.
        for (const req of pending) req.reject(err);
      }
    });
  }

  return {
    load(entityType, entityId) {
      return new Promise<TranslationData | null>((resolve, reject) => {
        let queue = queues.get(entityType);
        if (!queue) {
          queue = [];
          queues.set(entityType, queue);
          scheduleFlush(entityType);
        }
        queue.push({ entityId, resolve, reject });
      });
    },
  };
}
