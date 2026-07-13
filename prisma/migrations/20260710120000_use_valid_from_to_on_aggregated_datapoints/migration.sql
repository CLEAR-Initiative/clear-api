-- Replace the boolean `is_stale` invalidation model with a proper
-- bitemporal validity window on `aggregated_datapoints`. Rationale:
--
--   * Every recomputation can now insert a new row with
--     `valid_from = now()` and stamp the previous current row's
--     `valid_to = now()` — historical snapshots survive by design.
--   * "What did the dashboard show a week ago?" becomes a clean
--     `WHERE valid_from <= '...' AND (valid_to IS NULL OR valid_to > '...')`.
--   * Different admin levels tick at different rates naturally: an A2
--     bucket's `valid_from` advances when its A2-specific data
--     changes, while the parent A1 advances only when any child A2
--     changes.
--
-- Safe to run: no rows exist in `aggregated_datapoints` yet — the
-- Phase 2 pre-compute pipeline that populates them hasn't been wired
-- to any schedule.

-- ── Add the new validity columns ─────────────────────────────────
ALTER TABLE "aggregated_datapoints"
  ADD COLUMN "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "valid_to" TIMESTAMP(3);

-- ── Drop the old invalidation flag + full unique index ──────────
DROP INDEX "aggregated_datapoints_is_stale_idx";
DROP INDEX "aggregated_datapoints_window_start_window_end_window_kind_l_key";

ALTER TABLE "aggregated_datapoints" DROP COLUMN "is_stale";

-- ── New indexes to support current-version + history queries ─────
CREATE INDEX "aggregated_datapoints_valid_to_idx" ON "aggregated_datapoints"("valid_to");

CREATE INDEX "aggregated_datapoints_window_kind_window_start_location_id_schema_version_idx"
  ON "aggregated_datapoints"("window_kind", "window_start", "location_id", "schema_version");

-- Partial unique index enforcing "at most ONE current row per bucket
-- key". History rows (valid_to NOT NULL) don't participate, so the
-- table accumulates every historical snapshot without conflict.
-- NULLS NOT DISTINCT (Postgres 15+) treats NULL location_id as
-- equal — matches what we want for country-wide buckets.
CREATE UNIQUE INDEX "aggregated_datapoints_current_bucket_uk"
  ON "aggregated_datapoints"("window_start", "window_end", "window_kind", "location_id", "schema_version")
  NULLS NOT DISTINCT
  WHERE "valid_to" IS NULL;
