-- The Outcome log (ADR-0020): one row records where one pipeline run placed
-- one Signal. Append-only. Location precision reads the last LIVE row of each
-- Signal, so a replay adds rows and changes no history.

-- CreateEnum
CREATE TYPE "LocationRunKind" AS ENUM ('LIVE', 'REPLAY');

-- CreateEnum
CREATE TYPE "LocationOutcomeStep" AS ENUM ('ARRIVAL', 'PROCESSED');

-- CreateTable
CREATE TABLE "signal_location_outcomes" (
    "id" BIGSERIAL NOT NULL,
    "signal_id" TEXT NOT NULL,
    "located_at" TIMESTAMP(3) NOT NULL,
    "location_id" TEXT,
    "level" INTEGER,
    "run_kind" "LocationRunKind" NOT NULL DEFAULT 'LIVE',
    "step" "LocationOutcomeStep" NOT NULL,
    "pipeline_version" TEXT,
    "run_id" TEXT,

    CONSTRAINT "signal_location_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signal_location_outcomes_signal_id_run_kind_located_at_idx" ON "signal_location_outcomes"("signal_id", "run_kind", "located_at");

-- CreateIndex
CREATE INDEX "signal_location_outcomes_run_kind_located_at_idx" ON "signal_location_outcomes"("run_kind", "located_at");

-- AddForeignKey
ALTER TABLE "signal_location_outcomes" ADD CONSTRAINT "signal_location_outcomes_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_location_outcomes" ADD CONSTRAINT "signal_location_outcomes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one LIVE Outcome per Signal a pipeline brought in, with the
-- values location precision read until now (ADR-0012): the instant
-- COALESCE(processed_at, collected_at), and the pipeline location (the
-- Signal's own location, or once a person corrected it, the location the
-- first correction overwrote). Retracted and dummy Signals get a row too:
-- both flags can change later, and the metric filters on them when it reads.
INSERT INTO "signal_location_outcomes" ("signal_id", "located_at", "location_id", "level", "run_kind", "step")
SELECT s."id",
  COALESCE(s."processed_at", s."collected_at"),
  l."id",
  l."level",
  'LIVE',
  CASE WHEN s."processed_at" IS NULL THEN 'ARRIVAL' ELSE 'PROCESSED' END::"LocationOutcomeStep"
FROM "signals" s
LEFT JOIN "locations" l ON l."id" = CASE
  WHEN s."location_corrected_at" IS NULL THEN COALESCE(s."location_id", s."origin_id", s."destination_id")
  ELSE s."pipeline_location_id"
END
WHERE s."submitted_by_id" IS NULL
  AND s."raw_data"->>'manual' IS DISTINCT FROM 'true';
