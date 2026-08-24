-- Add situationAnalysis as a translatable entity type.
--
-- Extends the polymorphic `translations` table with a typed
-- `situation_analysis_id` FK, mirroring the event/crisis/location
-- relations added in 20260617150000. Situation-analysis rows are
-- bitemporal (every weekly regeneration is a new id), so a translation
-- keyed to a situation-analysis id is naturally scoped to that
-- generation and cascade-deletes with it.
--
-- Idempotent (IF NOT EXISTS / catalog guards) so a partial prior run is
-- safe to re-apply, matching the style of the earlier translation migration.

-- ─── 1. Column ──────────────────────────────────────────────────────────────
ALTER TABLE "translations" ADD COLUMN IF NOT EXISTS "situation_analysis_id" TEXT;

-- ─── 2. Foreign key ─────────────────────────────────────────────────────────
-- Guarded add — Postgres lacks ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname = 'translations_situation_analysis_id_fkey'
  ) THEN
    ALTER TABLE "translations"
      ADD CONSTRAINT "translations_situation_analysis_id_fkey"
      FOREIGN KEY ("situation_analysis_id")
      REFERENCES "situation_analyses"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 3. Per-FK uniqueness ───────────────────────────────────────────────────
-- One translation row per (situation analysis, locale). NULL FKs are
-- distinct under Postgres semantics, so this doesn't collide with the
-- event/crisis/location rows that leave this column NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "translations_situation_analysis_id_locale_key"
  ON "translations" ("situation_analysis_id", "locale");

-- ─── 4. Extend the exactly-one-FK CHECK ─────────────────────────────────────
-- The prior constraint summed only the first three FKs and required =1,
-- so a situationAnalysis row (all three NULL, situation_analysis_id set)
-- would sum to 0 and be rejected. Drop and re-create it to count the new
-- column too.
ALTER TABLE "translations" DROP CONSTRAINT IF EXISTS "translations_exactly_one_fk";

ALTER TABLE "translations"
  ADD CONSTRAINT "translations_exactly_one_fk"
  CHECK (
    ("event_id"              IS NOT NULL)::int
  + ("crisis_id"             IS NOT NULL)::int
  + ("location_id"           IS NOT NULL)::int
  + ("situation_analysis_id" IS NOT NULL)::int
  = 1
  );
