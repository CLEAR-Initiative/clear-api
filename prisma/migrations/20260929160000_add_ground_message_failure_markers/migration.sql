-- Durable per-stage failure markers for the clear-pipeline ground drains
-- (ground_hotline_enrich, ground_transcribe). Replaces the Redis-only
-- "parked" counter: a marked message drops out of its drain's queue until a
-- reviewer retries it. Nullable, no default — additive only.

-- AlterTable
ALTER TABLE "ground_messages" ADD COLUMN     "enrich_error" TEXT,
ADD COLUMN     "enrich_failed_at" TIMESTAMP(3),
ADD COLUMN     "transcribe_error" TEXT,
ADD COLUMN     "transcribe_failed_at" TIMESTAMP(3);
