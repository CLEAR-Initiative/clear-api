-- NOTE: `prisma migrate dev` also emitted DROP INDEX statements for
-- aggregated_datapoints_current_bucket_uk, knowledgebase_embedding_hnsw_idx,
-- knowledgebase_lexical_tsv_idx and situation_analyses_current_bucket_uk —
-- same false-positive drift as 20260804113017_add_ground_intel_staging_tier
-- (raw-SQL/Unsupported() objects not modelled in schema.prisma). Removed by
-- hand; this migration only ADDS the two signals columns.

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "content_hash" TEXT,
ADD COLUMN     "last_revised_at" TIMESTAMP(3);
