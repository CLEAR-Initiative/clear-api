-- Add `window_kind` to situation_analyses and rekey the current-row
-- uniqueness onto it.
--
-- Why: reads derive the analysis window from a `year` argument, and the
-- Dagster writer derives it independently in Python. The two calendars
-- disagreed on end-of-day — the writer sent 23:59:59.000, the resolver
-- looked for 23:59:59.999 — and because the read matched `window_end` on
-- exact equality, every read returned null while every write succeeded.
-- An empty dashboard, nothing erroring.
--
-- The fix is to stop keying on `window_end` at all. It is a derived
-- detail; `window_start` is unambiguous (both sides agree on midnight),
-- and `window_kind` states the granularity explicitly instead of leaving
-- it implied by a pair of timestamps. Mirrors `aggregated_datapoints`,
-- which has carried `window_kind` from the start.
--
-- `window_end` is kept as a column: it is useful for display and range
-- work. It is simply no longer part of any key.

-- AlterTable
-- Existing rows predate the column, so backfill via DEFAULT, then drop
-- the default: `window_kind` belongs to the bucket key, and the writer
-- must state it rather than inherit a silent fallback. Every row written
-- so far is a calendar-year analysis, so 'yearly' is the correct backfill.
ALTER TABLE "situation_analyses" ADD COLUMN "window_kind" TEXT NOT NULL DEFAULT 'yearly';
ALTER TABLE "situation_analyses" ALTER COLUMN "window_kind" DROP DEFAULT;

-- Rekey the partial unique index onto
-- (country_location_id, window_kind, window_start, schema_version).
--
-- Dropping `window_end` from the key narrows it. That is safe here only
-- because at most one current row per (country, window_start,
-- schema_version) can exist in practice — a single country-year is
-- generated once per weekly run, and each run supersedes the previous
-- row. If two current rows somehow differed only by `window_end`, this
-- index creation would fail loudly rather than corrupt anything, which
-- is the outcome we want.
DROP INDEX "situation_analyses_current_bucket_uk";

CREATE UNIQUE INDEX "situation_analyses_current_bucket_uk"
  ON "situation_analyses"("country_location_id", "window_kind", "window_start", "schema_version")
  NULLS NOT DISTINCT
  WHERE "valid_to" IS NULL;

-- The non-unique lookup index gains window_kind for the same reason: the
-- read path filters on (country_location_id, window_kind, window_start).
DROP INDEX "situation_analyses_country_location_id_window_start_idx";

CREATE INDEX "situation_analyses_country_window_kind_window_start_idx"
  ON "situation_analyses"("country_location_id", "window_kind", "window_start");
