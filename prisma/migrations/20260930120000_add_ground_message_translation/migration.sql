-- On-demand translation of hotline messages (#627).
--
-- 1. `ground_messages.language` — detected at intake by a cheap script +
--    stopword detector (no LLM); NULL when unknown. Existing rows stay NULL:
--    the translation prompt handles an unknown source language.
-- 2. `groundMessage` as a translatable entity type: a typed
--    `ground_message_id` FK on the polymorphic `translations` table,
--    mirroring situation_analysis_id (20260818120000) and analysis_id
--    (20260922000000). `ground_messages.text` is never overwritten — the
--    translation is a read-only overlay row that cascade-deletes with the
--    message.
--
-- Idempotent (IF NOT EXISTS / catalog guards) so a partial prior run is
-- safe to re-apply, matching the earlier translation migrations.

-- ─── 1. Detected language ───────────────────────────────────────────────────
ALTER TABLE "ground_messages" ADD COLUMN IF NOT EXISTS "language" TEXT;

-- ─── 2. Typed FK column ─────────────────────────────────────────────────────
ALTER TABLE "translations" ADD COLUMN IF NOT EXISTS "ground_message_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'translations_ground_message_id_fkey'
  ) THEN
    ALTER TABLE "translations"
      ADD CONSTRAINT "translations_ground_message_id_fkey"
      FOREIGN KEY ("ground_message_id") REFERENCES "ground_messages"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- One translation row per (ground message, locale). NULL FKs are distinct
-- under Postgres semantics, so this doesn't collide with the other types.
CREATE UNIQUE INDEX IF NOT EXISTS "translations_ground_message_id_locale_key"
  ON "translations" ("ground_message_id", "locale");

-- ─── 3. Extend the exactly-one-FK CHECK ─────────────────────────────────────
-- Count the new column so a groundMessage translation (every other FK NULL)
-- sums to 1 rather than 0 and is accepted.
ALTER TABLE "translations" DROP CONSTRAINT IF EXISTS "translations_exactly_one_fk";
ALTER TABLE "translations"
  ADD CONSTRAINT "translations_exactly_one_fk"
  CHECK (
    ("event_id"              IS NOT NULL)::int
  + ("crisis_id"             IS NOT NULL)::int
  + ("location_id"           IS NOT NULL)::int
  + ("situation_analysis_id" IS NOT NULL)::int
  + ("analysis_id"           IS NOT NULL)::int
  + ("ground_message_id"     IS NOT NULL)::int
  = 1
  );
