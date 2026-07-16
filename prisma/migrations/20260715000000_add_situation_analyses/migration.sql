-- Pre-computed situation-analysis snapshots per (country × year).
-- Bitemporal validity mirrors aggregated_datapoints: every weekly
-- regeneration inserts a new "current" row and stamps validTo on the
-- previous one in the same transaction. Partial unique index at the
-- bottom enforces at-most-one current row per bucket key.

-- CreateTable
CREATE TABLE "situation_analyses" (
    "id" TEXT NOT NULL,
    "country_location_id" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "source_report_ids" TEXT[],
    "aggregated_datapoint_id" TEXT,
    "generated_by_model" TEXT NOT NULL,
    "generation_cost_usd" DOUBLE PRECISION,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "schema_version" TEXT NOT NULL,

    CONSTRAINT "situation_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "situation_analyses_country_location_id_window_start_idx" ON "situation_analyses"("country_location_id", "window_start");

-- CreateIndex
CREATE INDEX "situation_analyses_valid_to_idx" ON "situation_analyses"("valid_to");

-- CreateIndex
CREATE INDEX "situation_analyses_schema_version_idx" ON "situation_analyses"("schema_version");

-- Partial unique index — at most ONE current row per bucket key.
-- History rows (valid_to NOT NULL) don't participate, so the table
-- accumulates every historical snapshot without conflict.
-- NULLS NOT DISTINCT (Postgres 15+) is defensive — country_location_id
-- is NOT NULL today, but the clause future-proofs against a country-
-- wide "global" row we might want later.
CREATE UNIQUE INDEX "situation_analyses_current_bucket_uk"
  ON "situation_analyses"("country_location_id", "window_start", "window_end", "schema_version")
  NULLS NOT DISTINCT
  WHERE "valid_to" IS NULL;
