-- NOTE: `prisma migrate dev` also emitted DROP INDEX statements for
-- knowledgebase_embedding_hnsw_idx, knowledgebase_lexical_tsv_idx,
-- aggregated_datapoints_current_bucket_uk and
-- situation_analyses_current_bucket_uk. Those indexes are created by raw
-- SQL in earlier migrations and are intentionally NOT modelled in
-- schema.prisma (Unsupported() columns / partial unique indexes), so the
-- diff engine sees them as drift. The drops were removed by hand - this
-- migration only ADDS the ground_* staging tables.

-- CreateTable
CREATE TABLE "ground_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "transport_id" TEXT NOT NULL,
    "consent_scope" TEXT,
    "consent_recorded_at" TIMESTAMP(3),
    "consent_recorded_by" TEXT,
    "privacy_default" TEXT NOT NULL DEFAULT 'private',
    "reviewer_roles" TEXT[] DEFAULT ARRAY['admin', 'analyst']::TEXT[],
    "retention_rule" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ground_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ground_threads" (
    "id" TEXT NOT NULL,
    "ground_source_id" TEXT NOT NULL,
    "title" TEXT,
    "lifecycle_state" TEXT NOT NULL DEFAULT 'reported',
    "review_state" TEXT NOT NULL DEFAULT 'unverified',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "promoted_signal_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ground_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ground_messages" (
    "id" TEXT NOT NULL,
    "ground_source_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "sender_ref" TEXT NOT NULL,
    "sender_name" TEXT,
    "text" TEXT NOT NULL,
    "media_keys" TEXT[],
    "media_refs" TEXT[],
    "omitted_media_count" INTEGER NOT NULL DEFAULT 0,
    "classification" TEXT,
    "uncertainty" TEXT,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "thread_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ground_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ground_sources_transport_id_key" ON "ground_sources"("transport_id");

-- CreateIndex
CREATE INDEX "ground_sources_kind_idx" ON "ground_sources"("kind");

-- CreateIndex
CREATE INDEX "ground_threads_ground_source_id_review_state_idx" ON "ground_threads"("ground_source_id", "review_state");

-- CreateIndex
CREATE INDEX "ground_threads_review_state_created_at_idx" ON "ground_threads"("review_state", "created_at");

-- CreateIndex
CREATE INDEX "ground_messages_ground_source_id_sent_at_idx" ON "ground_messages"("ground_source_id", "sent_at");

-- CreateIndex
CREATE INDEX "ground_messages_thread_id_idx" ON "ground_messages"("thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "ground_messages_ground_source_id_external_id_key" ON "ground_messages"("ground_source_id", "external_id");

-- AddForeignKey
ALTER TABLE "ground_threads" ADD CONSTRAINT "ground_threads_ground_source_id_fkey" FOREIGN KEY ("ground_source_id") REFERENCES "ground_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ground_messages" ADD CONSTRAINT "ground_messages_ground_source_id_fkey" FOREIGN KEY ("ground_source_id") REFERENCES "ground_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ground_messages" ADD CONSTRAINT "ground_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "ground_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "aggregated_datapoints_window_kind_window_start_location_id_sche" RENAME TO "aggregated_datapoints_window_kind_window_start_location_id__idx";
