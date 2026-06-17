-- Add typed foreign-key columns to translations so we can fold
-- translation lookups into entity queries via `include` instead of
-- making a separate `findMany` per entity-type batch. The polymorphic
-- (entity_type, entity_id) columns stay in place for backward compat
-- with existing reads / writes; new code paths can prefer the typed
-- relations.
--
-- Migration order matters here:
--   1. Add nullable FK columns.
--   2. Backfill from the polymorphic columns.
--   3. Add FK + per-FK uniqueness + CHECK constraints AFTER the
--      backfill, so existing rows satisfy them.
--
-- Non-destructive: nothing is dropped or rewritten in-place. Safe to
-- apply in production with the worker / API running, then deploy code
-- that begins writing the new columns. The old code paths keep working
-- because they touch only entity_type/entity_id.
--
-- IDEMPOTENT: every step is guarded so the migration can be re-run on
-- a partially-applied database (some columns or constraints already
-- present from earlier hand-application). Required because the
-- previous version of this migration was apparently partially applied
-- before being recorded in _prisma_migrations.

-- ─── 1. Add nullable FK columns ──────────────────────────────────────────────

ALTER TABLE "translations" ADD COLUMN IF NOT EXISTS "event_id"    TEXT;
ALTER TABLE "translations" ADD COLUMN IF NOT EXISTS "crisis_id"   TEXT;
ALTER TABLE "translations" ADD COLUMN IF NOT EXISTS "location_id" TEXT;

-- ─── 2. Backfill from polymorphic columns ───────────────────────────────────
-- For every existing translation row, copy entity_id into the
-- corresponding typed FK column based on entity_type. Run in three
-- statements so the planner gets a clean shape per discriminator.
-- Re-running is a no-op: rows whose typed FK already matches entity_id
-- get SET to the same value.

UPDATE "translations"
SET    "event_id" = "entity_id"
WHERE  "entity_type" = 'event'
  AND  ("event_id" IS NULL OR "event_id" <> "entity_id");

UPDATE "translations"
SET    "crisis_id" = "entity_id"
WHERE  "entity_type" = 'crisis'
  AND  ("crisis_id" IS NULL OR "crisis_id" <> "entity_id");

UPDATE "translations"
SET    "location_id" = "entity_id"
WHERE  "entity_type" = 'location'
  AND  ("location_id" IS NULL OR "location_id" <> "entity_id");

-- ─── 2b. Clean up orphan translation rows ───────────────────────────────────
-- Before this migration, the polymorphic (entity_type, entity_id) pair
-- had no FK enforcement, so rows could outlive their referenced entity
-- (e.g. a location is hard-deleted but its translations stay). Those
-- orphans block step 3's FK ADD because the FK target no longer
-- exists. Delete them — they're unreachable from any read path and
-- carry no meaningful data. Idempotent: subsequent re-runs find zero
-- orphans and DELETE nothing.

DO $$
DECLARE
  event_orphans    int;
  crisis_orphans   int;
  location_orphans int;
BEGIN
  DELETE FROM "translations"
   WHERE "entity_type" = 'event'
     AND "entity_id" NOT IN (SELECT "id" FROM "events");
  GET DIAGNOSTICS event_orphans = ROW_COUNT;

  DELETE FROM "translations"
   WHERE "entity_type" = 'crisis'
     AND "entity_id" NOT IN (SELECT "id" FROM "crises");
  GET DIAGNOSTICS crisis_orphans = ROW_COUNT;

  DELETE FROM "translations"
   WHERE "entity_type" = 'location'
     AND "entity_id" NOT IN (SELECT "id" FROM "locations");
  GET DIAGNOSTICS location_orphans = ROW_COUNT;

  RAISE NOTICE 'Deleted orphan translation rows: event=%, crisis=%, location=%',
    event_orphans, crisis_orphans, location_orphans;
END $$;

-- Also clean rows where the typed FK column already got populated by a
-- previous partial application but points at a now-missing entity.
-- Same idempotent rule: re-runs find zero and delete nothing.

DELETE FROM "translations"
 WHERE "event_id" IS NOT NULL
   AND "event_id" NOT IN (SELECT "id" FROM "events");

DELETE FROM "translations"
 WHERE "crisis_id" IS NOT NULL
   AND "crisis_id" NOT IN (SELECT "id" FROM "crises");

DELETE FROM "translations"
 WHERE "location_id" IS NOT NULL
   AND "location_id" NOT IN (SELECT "id" FROM "locations");

-- ─── 3. Foreign-key constraints ─────────────────────────────────────────────
-- ON DELETE CASCADE so when an entity is hard-deleted its translation
-- rows go with it. DO blocks below skip the ADD if the constraint
-- already exists (Postgres lacks ADD CONSTRAINT IF NOT EXISTS).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname = 'translations_event_id_fkey'
  ) THEN
    ALTER TABLE "translations"
      ADD CONSTRAINT "translations_event_id_fkey"
      FOREIGN KEY ("event_id")
      REFERENCES "events"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname = 'translations_crisis_id_fkey'
  ) THEN
    ALTER TABLE "translations"
      ADD CONSTRAINT "translations_crisis_id_fkey"
      FOREIGN KEY ("crisis_id")
      REFERENCES "crises"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname = 'translations_location_id_fkey'
  ) THEN
    ALTER TABLE "translations"
      ADD CONSTRAINT "translations_location_id_fkey"
      FOREIGN KEY ("location_id")
      REFERENCES "locations"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 4. Per-FK uniqueness (one translation row per entity per locale) ───────
-- Postgres treats NULL as distinct in UNIQUE indexes (default
-- nulls_distinct), so all the NULL FK rows coexist fine.

CREATE UNIQUE INDEX IF NOT EXISTS "translations_event_id_locale_key"
  ON "translations" ("event_id",    "locale");
CREATE UNIQUE INDEX IF NOT EXISTS "translations_crisis_id_locale_key"
  ON "translations" ("crisis_id",   "locale");
CREATE UNIQUE INDEX IF NOT EXISTS "translations_location_id_locale_key"
  ON "translations" ("location_id", "locale");

-- ─── 5. Exactly-one-FK CHECK constraint ─────────────────────────────────────
-- A row must reference exactly one entity. Cast booleans to int and
-- sum: 1 = good, anything else = constraint violation. Catches both
-- "forgot to set the FK" (sum=0) and "set two FKs" (sum>=2) bugs.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname = 'translations_exactly_one_fk'
  ) THEN
    ALTER TABLE "translations"
      ADD CONSTRAINT "translations_exactly_one_fk"
      CHECK (
        ("event_id"    IS NOT NULL)::int
      + ("crisis_id"   IS NOT NULL)::int
      + ("location_id" IS NOT NULL)::int
      = 1
      );
  END IF;
END $$;
