import { gql } from "graphql-tag";

export const translationTypeDef = gql`
  """
  A single translation row, returned by the admin/pipeline-only
  translations(entityType, entityId) query so the pipeline can compare
  stored source-hashes against the canonical row and decide which fields
  (if any) need re-translating.
  """
  type TranslationRow {
    locale: String!
    """
    Translated payload, same shape as the canonical entity per type.
    """
    data: JSON!
    """
    Per-field SHA-256 hashes of the canonical English source that was
    used to produce \`data\`. Null on rows written before hashes were
    introduced — treat null as "all fields stale".
    """
    sourceHashes: JSON
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  Result of upserting one or more locale rows for a given entity. Carries
  the locales that were written so the caller (typically clear-pipeline)
  can confirm coverage without a follow-up read.
  """
  type UpsertTranslationsResult {
    entityType: String!
    entityId: String!
    locales: [String!]!
  }

  """
  Per-(entity_type, locale) coverage snapshot used by the admin
  dashboard to see how much of the catalog has been translated.

  - canonicalCount: total entities of this type that *could* be
    translated (i.e. exist in the canonical table).
  - translatedCount: number with a row in the translations sidecar
    for this locale.

  The fraction translatedCount / canonicalCount is the live coverage
  for that (type, locale) cell — anything < 1.0 means the next read of
  one of the missing entities by a user on that locale will fall back
  to canonical English (and trigger the lazy-on-read enqueue, see
  utils/translation-loader.ts).
  """
  type TranslationCoverage {
    entityType: String!
    locale: String!
    canonicalCount: Int!
    translatedCount: Int!
  }

  """
  Per-locale payload accepted by upsertTranslations. data mirrors the
  canonical entity's JSON shape exactly for the given locale — e.g. for
  a crisis it carries the localized title/summary/scenarios/needs with
  the same keys/nesting the English columns use.
  """
  input LocaleTranslationInput {
    """BCP-47 lowercased — 'ar', 'fr', 'fa', 'ps'. 'en' is rejected (canonical)."""
    locale: String!
    """Translated payload. Shape mirrors the canonical entity per type."""
    data: JSON!
    """Per-field SHA-256 hashes of the canonical English source used to produce \`data\`. Stored so the pipeline can detect which canonical field changed and re-translate only that field on the next pass."""
    sourceHashes: JSON!
  }

  input UpsertTranslationsInput {
    """One of 'event' | 'crisis' | 'location' (case-insensitive)."""
    entityType: String!
    entityId: String!
    """One entry per target locale. Each row is upserted independently."""
    translations: [LocaleTranslationInput!]!
  }
`;
