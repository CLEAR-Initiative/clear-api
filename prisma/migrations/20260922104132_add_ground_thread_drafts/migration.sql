-- NOTE: `prisma migrate dev` also emitted DROP INDEX statements for
-- aggregated_datapoints_current_bucket_uk, knowledgebase_embedding_hnsw_idx,
-- knowledgebase_lexical_tsv_idx and situation_analyses_current_bucket_uk —
-- same false-positive drift as 20260831094030_add_signal_content_hash_and_last_revised_at
-- (raw-SQL/Unsupported() objects not modelled in schema.prisma). Removed by
-- hand; this migration only touches ground_threads + its FK to locations.

-- AlterTable
ALTER TABLE "ground_threads" ADD COLUMN     "draft_disaster_type" TEXT,
ADD COLUMN     "draft_location_id" TEXT,
ADD COLUMN     "draft_severity" INTEGER,
ADD COLUMN     "draft_title" TEXT;

-- AddForeignKey
ALTER TABLE "ground_threads" ADD CONSTRAINT "ground_threads_draft_location_id_fkey" FOREIGN KEY ("draft_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
