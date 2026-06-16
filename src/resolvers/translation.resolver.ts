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
]);

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
  let found: { id: string } | null = null;
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
  } else {
    found = await ctx.prisma.locations.findUnique({
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
      const entityType = args.entityType.toLowerCase() as TranslatableEntityType;
      if (!VALID_ENTITY_TYPES.has(entityType)) {
        throw new GraphQLError(
          `Invalid entityType "${args.entityType}". Must be one of: event, crisis, location.`,
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
    translationCoverage: async (
      _parent: unknown,
      _args: unknown,
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const [grouped, eventCount, crisisCount, locationCount] = await Promise.all([
        context.prisma.translations.groupBy({
          by: ["entityType", "locale"],
          _count: { entityId: true },
        }),
        context.prisma.events.count(),
        context.prisma.crises.count(),
        context.prisma.locations.count(),
      ]);

      const canonical: Record<TranslatableEntityType, number> = {
        event: eventCount,
        crisis: crisisCount,
        location: locationCount,
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
      for (const entityType of ["event", "crisis", "location"] as TranslatableEntityType[]) {
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
  },

  Mutation: {
    upsertTranslations: async (
      _parent: unknown,
      args: { input: UpsertTranslationsInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "pipeline"]);
      const { input } = args;

      // Entity-type validation. Lowercased for forgiveness; the storage
      // value is canonical so admin/pipeline callers never accidentally
      // create 'Event' / 'event' partitions of the same data.
      const entityType = input.entityType.toLowerCase() as TranslatableEntityType;
      if (!VALID_ENTITY_TYPES.has(entityType)) {
        throw new GraphQLError(
          `Invalid entityType "${input.entityType}". Must be one of: event, crisis, location.`,
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
        input.translations.map((t) =>
          context.prisma.translations.upsert({
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
              locale: t.locale.toLowerCase(),
              data: t.data as Prisma.InputJsonValue,
              sourceHashes: t.sourceHashes as Prisma.InputJsonValue,
            },
            update: {
              data: t.data as Prisma.InputJsonValue,
              sourceHashes: t.sourceHashes as Prisma.InputJsonValue,
            },
          }),
        ),
      );

      return {
        entityType,
        entityId: input.entityId,
        locales: input.translations.map((t) => t.locale.toLowerCase()),
      };
    },
  },
};
