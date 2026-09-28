-- Unified frame-scoped analysis (ADR-0007). One bitemporal `analyses` row
-- per (frame × schema_version) generalises `situation_analyses` from a
-- (country × calendar window) bucket to an arbitrary FRAME expressed as the
-- same columns the knowledgebase is indexed on, and subsumes `crises`
-- ("crisis overview" = an event-derived frame). `analysis_automations` are
-- subscriptions that keep a frame's analysis current on a cadence. Ingest is
-- untouched; the frame is applied only at generation time.

-- ─── 1. analyses ────────────────────────────────────────────────────────────
CREATE TABLE "analyses" (
    "id" TEXT NOT NULL,
    "location_ids" TEXT[],
    "event_types" TEXT[],
    "need_sectors" TEXT[],
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "source_report_ids" TEXT[],
    "generated_by_model" TEXT NOT NULL,
    "generation_cost_usd" DOUBLE PRECISION,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "schema_version" TEXT NOT NULL,

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analyses_valid_to_idx" ON "analyses"("valid_to");
CREATE INDEX "analyses_schema_version_idx" ON "analyses"("schema_version");
CREATE INDEX "analyses_window_start_idx" ON "analyses"("window_start");
CREATE INDEX "analyses_location_ids_idx" ON "analyses" USING GIN ("location_ids");
CREATE INDEX "analyses_event_types_idx" ON "analyses" USING GIN ("event_types");
CREATE INDEX "analyses_need_sectors_idx" ON "analyses" USING GIN ("need_sectors");

-- Partial unique index — at most ONE current row per (frame × schema_version).
-- History rows (valid_to NOT NULL) don't participate. NULLS NOT DISTINCT
-- (Postgres 15+) makes two ROLLING frames (window_end NULL) that share the
-- other columns dedupe to one current row — a plain unique would treat their
-- NULL window_end as distinct and let duplicates through. Array identity
-- relies on the resolver canonicalising (sort + de-dupe) the arrays on write.
CREATE UNIQUE INDEX "analyses_current_frame_uk"
  ON "analyses"("location_ids", "event_types", "need_sectors", "window_start", "window_end", "schema_version")
  NULLS NOT DISTINCT
  WHERE "valid_to" IS NULL;

-- ─── 2. analysis_automations ────────────────────────────────────────────────
CREATE TABLE "analysis_automations" (
    "id" TEXT NOT NULL,
    "location_ids" TEXT[],
    "event_types" TEXT[],
    "need_sectors" TEXT[],
    "window_start" TIMESTAMP(3) NOT NULL,
    "cadence" TEXT NOT NULL,
    "team_id" TEXT,
    "created_by_user_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_automations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_automations_enabled_idx" ON "analysis_automations"("enabled");
CREATE INDEX "analysis_automations_next_run_at_idx" ON "analysis_automations"("next_run_at");
CREATE INDEX "analysis_automations_location_ids_idx" ON "analysis_automations" USING GIN ("location_ids");

-- One subscription per (frame, owner): a re-subscribe updates cadence rather
-- than duplicating. NULLS NOT DISTINCT so the nullable owner columns of two
-- SYSTEM rows (team_id / created_by_user_id NULL) on the same frame collide
-- instead of slipping past as distinct. Different owners on the same frame are
-- allowed — the scheduler runs the frame at the minimum cadence across them.
CREATE UNIQUE INDEX "analysis_automations_frame_owner_uk"
  ON "analysis_automations"("location_ids", "event_types", "need_sectors", "window_start", "team_id", "created_by_user_id")
  NULLS NOT DISTINCT;

-- ─── 3. translations: add `analysis` as a translatable entity ───────────────
-- Mirrors the situation_analysis FK added in 20260818120000. Idempotent
-- guards so a partial prior run is safe to re-apply.
ALTER TABLE "translations" ADD COLUMN IF NOT EXISTS "analysis_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'translations_analysis_id_fkey'
  ) THEN
    ALTER TABLE "translations"
      ADD CONSTRAINT "translations_analysis_id_fkey"
      FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- One translation row per (analysis, locale). NULL FKs are distinct under
-- Postgres semantics, so this doesn't collide with the other entity types.
CREATE UNIQUE INDEX IF NOT EXISTS "translations_analysis_id_locale_key"
  ON "translations" ("analysis_id", "locale");

-- Extend the exactly-one-FK CHECK to count the new column, so an `analysis`
-- translation (all other FKs NULL) sums to 1 rather than 0 and is accepted.
ALTER TABLE "translations" DROP CONSTRAINT IF EXISTS "translations_exactly_one_fk";
ALTER TABLE "translations"
  ADD CONSTRAINT "translations_exactly_one_fk"
  CHECK (
    ("event_id"              IS NOT NULL)::int
  + ("crisis_id"             IS NOT NULL)::int
  + ("location_id"           IS NOT NULL)::int
  + ("situation_analysis_id" IS NOT NULL)::int
  + ("analysis_id"           IS NOT NULL)::int
  = 1
  );

-- ─── 4. analysis_requests (on-demand generation queue, ADR-0007 §4) ─────────
CREATE TYPE "AnalysisRequestStatus" AS ENUM ('PENDING', 'GENERATED', 'FAILED');

CREATE TABLE "analysis_requests" (
    "id" TEXT NOT NULL,
    "location_ids" TEXT[],
    "event_types" TEXT[],
    "need_sectors" TEXT[],
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3),
    "status" "AnalysisRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_user_id" TEXT,
    "team_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "analysis_requests_status_idx" ON "analysis_requests"("status");
