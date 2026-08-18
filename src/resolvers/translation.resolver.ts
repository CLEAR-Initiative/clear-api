import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";
import {
  isSupportedLocale,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
} from "../utils/locales.js";
import type { TranslatableEntityType } from "../utils/translation-loader.js";
import { Prisma } from "../generated/prisma/client.js";

interface LocaleTranslationInput {
  locale: string;
  data: Record<string, unknown>;
  sourceHashes: Record<string, string>;
}

interface UpsertTranslationsInput {
  entityType: string;
  entityId: string;
  translations: LocaleTranslationInput[];
}

const VALID_ENTITY_TYPES: ReadonlySet<TranslatableEntityType> = new Set([
  "event",
  "crisis",
  "location",
  "situationAnalysis",
]);

const ENTITY_TYPE_LIST = [...VALID_ENTITY_TYPES].join(", ");

/**
 * Case-insensitively resolve a caller-supplied entity type to its canonical
 * `TranslatableEntityType` (e.g. "situationanalysis" -> "situationAnalysis"),
 * or null if unknown. Callers used to `.toLowerCase()` inline, which was safe
 * while every type was already lowercase but silently breaks camelCase types
 * like `situationAnalysis` — always normalize through here instead.
 */
function normalizeEntityType(raw: string): TranslatableEntityType | null {
  const lower = raw.toLowerCase();
  for (const t of VALID_ENTITY_TYPES) {
    if (t.toLowerCase() === lower) return t;
  }
  return null;
}

/**
 * Confirm the entity row exists before writing a translation for it.
 * Dangling translation rows are harmless (no reader looks at them) but
 * writing them on a typo'd id silently hides the bug — failing fast
 * here is cheap and the call site is admin/pipeline only.
 */
async function assertEntityExists(
  ctx: Context,
  entityType: TranslatableEntityType,
  entityId: string,
): Promise<void> {
  let found: { id: string } | null;
  if (entityType === "event") {
    found = await ctx.prisma.events.findUnique({
      where: { id: entityId },
      select: { id: true },
    });
  } else if (entityType === "crisis") {
    found = await ctx.prisma.crises.findUnique({
      where: { id: entityId },
      select: { id: true },
    });
  } else if (entityType === "location") {
    found = await ctx.prisma.locations.findUnique({
      where: { id: entityId },
      select: { id: true },
    });
  } else {
    found = await ctx.prisma.situationAnalysis.findUnique({
      where: { id: entityId },
      select: { id: true },
    });
  }
  if (!found) {
    throw new GraphQLError(`${entityType} with id ${entityId} not found`, {
      extensions: { code: "NOT_FOUND" },
    });
  }
}

// Target locales for the coverage report. Skips 'en' because canonical
// English lives on the entity row itself — coverage is meaningless for
// it (always 100% by construction).
const COVERAGE_LOCALES = SUPPORTED_LOCALES.filter(
  (l) => l !== DEFAULT_LOCALE,
);

export const translationResolvers = {
  Query: {
    translations: async (
      _parent: unknown,
      args: { entityType: string; entityId: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const entityType = normalizeEntityType(args.entityType);
      if (!entityType) {
        throw new GraphQLError(
          `Invalid entityType "${args.entityType}". Must be one of: ${ENTITY_TYPE_LIST}.`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      return context.prisma.translations.findMany({
        where: { entityType, entityId: args.entityId },
        orderBy: { locale: "asc" },
      });
    },

    /**
     * Per-(entity_type, locale) translation coverage snapshot for the
     * admin dashboard. Two queries:
     *   1. Group the translations table by (entity_type, locale) and
     *      count rows.
     *   2. Count canonical rows per entity type (events, crises,
     *      locations) — one fast aggregate per table.
     * Then build the full N×M matrix so locales/types with zero rows
     * still show up as 0 instead of being silently dropped.
     */
    entitiesMissingTranslation: async (
      _parent: unknown,
      args: { entityType: string; locale: string },
      context: Context,
    ): Promise<string[]> => {
      requireRole(context, ["admin", "pipeline"]);
      const entityType = normalizeEntityType(args.entityType);
      if (!entityType) {
        throw new GraphQLError(
          `Invalid entityType "${args.entityType}". Must be one of: ${ENTITY_TYPE_LIST}.`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      const locale = args.locale.toLowerCase();
      if (locale === DEFAULT_LOCALE) {
        throw new GraphQLError(
          "locale 'en' is canonical; missing-translation lookup is undefined for it.",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      if (!isSupportedLocale(locale)) {
        throw new GraphQLError(`Unsupported locale "${locale}".`, {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Two findMany calls + a Set diff in app code instead of a raw
      // LEFT JOIN / NOT EXISTS. Faster to reason about and we're
      // bounded by canonical row counts in the thousands, not millions.
      let allRows: Array<{ id: string }>;
      if (entityType === "event") {
        allRows = await context.prisma.events.findMany({ select: { id: true } });
      } else if (entityType === "crisis") {
        allRows = await context.prisma.crises.findMany({ select: { id: true } });
      } else if (entityType === "location") {
        allRows = await context.prisma.locations.findMany({ select: { id: true } });
      } else {
        allRows = await context.prisma.situationAnalysis.findMany({
          select: { id: true },
        });
      }
      const translatedRows = await context.prisma.translations.findMany({
        where: { entityType, locale },
        select: { entityId: true },
      });
      const translated = new Set(translatedRows.map((r) => r.entityId));
      return allRows
        .filter((r) => !translated.has(r.id))
        .map((r) => r.id);
    },

    translationCoverage: async (
      _parent: unknown,
      _args: unknown,
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const [grouped, eventCount, crisisCount, locationCount, situationCount] =
        await Promise.all([
          context.prisma.translations.groupBy({
            by: ["entityType", "locale"],
            _count: { entityId: true },
          }),
          context.prisma.events.count(),
          context.prisma.crises.count(),
          context.prisma.locations.count(),
          context.prisma.situationAnalysis.count(),
        ]);

      const canonical: Record<TranslatableEntityType, number> = {
        event: eventCount,
        crisis: crisisCount,
        location: locationCount,
        situationAnalysis: situationCount,
      };

      // Build (translatedCount) lookup keyed by `${type}:${locale}`.
      const counts = new Map<string, number>();
      for (const row of grouped) {
        counts.set(`${row.entityType}:${row.locale}`, row._count.entityId);
      }

      const out: Array<{
        entityType: TranslatableEntityType;
        locale: string;
        canonicalCount: number;
        translatedCount: number;
      }> = [];
      for (const entityType of [...VALID_ENTITY_TYPES] as TranslatableEntityType[]) {
        for (const locale of COVERAGE_LOCALES) {
          out.push({
            entityType,
            locale,
            canonicalCount: canonical[entityType],
            translatedCount: counts.get(`${entityType}:${locale}`) ?? 0,
          });
        }
      }
      return out;
    },

    // The Dagster translation drain: entities enqueued for (re)translation,
    // oldest-first. This is the durable replacement for the lazy-on-read Celery
    // broker enqueue. Optional entityType/locale filters let a per-locale
    // consumer drain just its slice. Admin/pipeline only.
    pendingTranslations: async (
      _parent: unknown,
      args: { first?: number | null; entityType?: string | null; locale?: string | null },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const take = Math.min(Math.max(args.first ?? 100, 1), 500);
      const where: { entityType?: string; locale?: string } = {};
      if (args.entityType) where.entityType = args.entityType.toLowerCase();
      if (args.locale) where.locale = args.locale.toLowerCase();
      return context.prisma.translationQueue.findMany({
        where,
        orderBy: { enqueuedAt: "asc" },
        take,
      });
    },
  },

  Mutation: {
    // Durable replacement for the lazy-on-read Celery enqueue: mark an entity as
    // needing (re)translation at a locale so the Dagster drain picks it up. One
    // row per (entityType, entityId, locale) — a re-enqueue keeps the original
    // enqueuedAt (idempotent). Admin/pipeline only.
    enqueueTranslation: async (
      _parent: unknown,
      args: { entityType: string; entityId: string; locale: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const entityType = normalizeEntityType(args.entityType);
      if (!entityType) {
        throw new GraphQLError(
          `Invalid entityType "${args.entityType}". Must be one of: ${ENTITY_TYPE_LIST}.`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      const locale = args.locale.toLowerCase();
      if (locale === DEFAULT_LOCALE) {
        throw new GraphQLError(
          "locale 'en' is canonical and is never translated.",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      if (!isSupportedLocale(locale)) {
        throw new GraphQLError(`Unsupported locale "${locale}".`, {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      await assertEntityExists(context, entityType, args.entityId);
      return context.prisma.translationQueue.upsert({
        where: {
          entityType_entityId_locale: { entityType, entityId: args.entityId, locale },
        },
        create: { entityType, entityId: args.entityId, locale },
        update: {}, // idempotent — keep the original enqueuedAt
      });
    },

    // Explicit drain completion: remove an entity/locale from the queue. Returns
    // true when a queued row was actually removed. `upsertTranslations` clears
    // the queue itself, so consumers writing via that path need not call this.
    // Admin/pipeline only.
    markTranslated: async (
      _parent: unknown,
      args: { entityType: string; entityId: string; locale: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      // Normalize so a camelCase type (situationAnalysis) matches the stored
      // canonical value; fall back to the raw lowercase for forward-compat.
      const entityType =
        normalizeEntityType(args.entityType) ?? args.entityType.toLowerCase();
      const result = await context.prisma.translationQueue.deleteMany({
        where: {
          entityType,
          entityId: args.entityId,
          locale: args.locale.toLowerCase(),
        },
      });
      return result.count > 0;
    },

    upsertTranslations: async (
      _parent: unknown,
      args: { input: UpsertTranslationsInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const { input } = args;

      // Entity-type validation. Normalized case-insensitively to the canonical
      // value so admin/pipeline callers never accidentally create
      // 'Event' / 'event' partitions of the same data.
      const entityType = normalizeEntityType(input.entityType);
      if (!entityType) {
        throw new GraphQLError(
          `Invalid entityType "${input.entityType}". Must be one of: ${ENTITY_TYPE_LIST}.`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      if (!input.translations || input.translations.length === 0) {
        throw new GraphQLError(
          "translations must contain at least one locale entry.",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      // Locale validation up front so we don't commit partial work if
      // the 3rd of 4 locales has a typo. Refuse 'en' explicitly — the
      // canonical English lives on the entity row itself, not here.
      const seenLocales = new Set<string>();
      for (const t of input.translations) {
        const locale = t.locale.toLowerCase();
        if (locale === DEFAULT_LOCALE) {
          throw new GraphQLError(
            "locale 'en' is canonical and not stored in the translations table.",
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
        if (!isSupportedLocale(locale)) {
          throw new GraphQLError(`Unsupported locale "${locale}".`, {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        if (seenLocales.has(locale)) {
          throw new GraphQLError(`Duplicate locale "${locale}" in input.`, {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        seenLocales.add(locale);
        if (!t.data || typeof t.data !== "object") {
          throw new GraphQLError(
            `translations[${locale}].data must be an object.`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
        if (!t.sourceHashes || typeof t.sourceHashes !== "object") {
          throw new GraphQLError(
            `translations[${locale}].sourceHashes must be an object of canonical-field hashes.`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
      }

      await assertEntityExists(context, entityType, input.entityId);

      // Upserts run in a single transaction so a partial failure can't
      // leave the entity with e.g. AR but not FR when both were
      // requested. Each row is keyed off the (entity_type, entity_id,
      // locale) unique constraint defined in the migration.
      await context.prisma.$transaction(
        input.translations.map((t) => {
          // Populate the typed FK column matching entityType alongside
          // the polymorphic (entity_type, entity_id) pair so new rows
          // satisfy the migration's "exactly one FK" CHECK constraint
          // and are reachable via Prisma's typed `include` on the
          // entity's relation. The polymorphic columns stay populated
          // for the existing read paths until the loader is rewired.
          const typedFk: {
            eventId?: string;
            crisisId?: string;
            locationId?: string;
            situationAnalysisId?: string;
          } =
            entityType === "event"
              ? { eventId: input.entityId }
              : entityType === "crisis"
                ? { crisisId: input.entityId }
                : entityType === "location"
                  ? { locationId: input.entityId }
                  : { situationAnalysisId: input.entityId };
          return context.prisma.translations.upsert({
            where: {
              entityType_entityId_locale: {
                entityType,
                entityId: input.entityId,
                locale: t.locale.toLowerCase(),
              },
            },
            create: {
              entityType,
              entityId: input.entityId,
              ...typedFk,
              locale: t.locale.toLowerCase(),
              data: t.data as Prisma.InputJsonValue,
              sourceHashes: t.sourceHashes as Prisma.InputJsonValue,
            },
            update: {
              data: t.data as Prisma.InputJsonValue,
              sourceHashes: t.sourceHashes as Prisma.InputJsonValue,
              // Defensive backfill on update too — if an older row was
              // written before this migration, the next translation
              // upsert will fill in its typed FK alongside the new data.
              ...typedFk,
            },
          });
        }),
      );

      // The write IS the drain-completion signal: clear any queued
      // (re)translation requests for the locales we just wrote. Best-effort —
      // a leftover queue row would only cause a harmless re-drain.
      await context.prisma.translationQueue.deleteMany({
        where: {
          entityType,
          entityId: input.entityId,
          locale: { in: input.translations.map((t) => t.locale.toLowerCase()) },
        },
      });

      return {
        entityType,
        entityId: input.entityId,
        locales: input.translations.map((t) => t.locale.toLowerCase()),
      };
    },
  },
};
