-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('NEW', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "CrisisEnrichmentStatus" AS ENUM ('PENDING', 'ENRICHED');

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "raw_s3_key" TEXT,
ADD COLUMN     "status" "SignalStatus" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "processed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "crises" ADD COLUMN     "enrichment_status" "CrisisEnrichmentStatus" NOT NULL DEFAULT 'PENDING';

-- Backfill: existing rows were already processed / enriched by the Celery
-- pipeline, so the first Dagster drain (which pulls status = NEW / PENDING)
-- must skip all history. New rows keep the column defaults (NEW / PENDING).
UPDATE "signals" SET "status" = 'PROCESSED', "processed_at" = "collected_at";
UPDATE "crises" SET "enrichment_status" = 'ENRICHED';

-- CreateTable
CREATE TABLE "translation_queue" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "enqueued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translation_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signals_status_published_at_idx" ON "signals"("status", "published_at");

-- CreateIndex
CREATE INDEX "crises_enrichment_status_idx" ON "crises"("enrichment_status");

-- CreateIndex
CREATE UNIQUE INDEX "translation_queue_entity_type_entity_id_locale_key" ON "translation_queue"("entity_type", "entity_id", "locale");

-- CreateIndex
CREATE INDEX "translation_queue_enqueued_at_idx" ON "translation_queue"("enqueued_at");
