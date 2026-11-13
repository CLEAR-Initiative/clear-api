-- The location the pipeline gave a Signal, kept when a person's Location
-- challenge overwrites it, so location precision (ADR-0012) measures the
-- pipeline. Null while the Signal is uncorrected.
ALTER TABLE "signals" ADD COLUMN "pipeline_location_id" TEXT;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_pipeline_location_id_fkey" FOREIGN KEY ("pipeline_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill Signals corrected before this column existed: the location their
-- first applied challenge recorded when it was filed, the best record there is.
UPDATE "signals" s
SET "pipeline_location_id" = (
  SELECT c."previous_location_id" FROM "signal_location_challenges" c
  WHERE c."signal_id" = s."id" AND c."status" IN ('accepted', 'corrected')
  ORDER BY c."decided_at" ASC NULLS LAST, c."created_at" ASC
  LIMIT 1
)
WHERE s."location_corrected_at" IS NOT NULL;
