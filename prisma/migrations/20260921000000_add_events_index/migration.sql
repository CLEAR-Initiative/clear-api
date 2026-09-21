-- Incident-tier knowledge-base index (ADR-0006). One row per EVENT, embedded
-- as a synthesised "event card". Physically separate from `knowledgebase` (the
-- report/state tier) so the report KB is never polluted; searchKnowledgebase
-- retrieves both and merges tier-aware. Mirrors `knowledgebase`'s hand-written
-- DDL for the pgvector HNSW index + tsvector trigger Prisma can't express.
--
-- IMPORTANT: schema.prisma's `eventsIndex` has `Unsupported("vector(1024)")`
-- and `Unsupported("tsvector")` fields — do NOT drop them (it cascades the HNSW
-- index). Generate future migrations with `prisma migrate diff --from-migrations`.

CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "events_index" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "card_text" TEXT NOT NULL,
    "embedded_text" TEXT NOT NULL,
    "source_url" TEXT,
    "embedding_provider" TEXT NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "lexical_tsv" tsvector NOT NULL,
    "location_ids" TEXT[],
    "location_pcodes" TEXT[],
    "time_range_start" TIMESTAMP(3),
    "time_range_end" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "event_types" TEXT[],
    "severity" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_index_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One row per event; the write path deletes-then-inserts per event, so this
-- doubles as the replace-on-revise idempotency key.
CREATE UNIQUE INDEX "events_index_event_id_key" ON "events_index"("event_id");

-- CreateIndex
CREATE INDEX "events_index_embedding_model_idx" ON "events_index"("embedding_model");

-- CreateIndex
CREATE INDEX "events_index_location_ids_idx" ON "events_index" USING GIN ("location_ids");

-- CreateIndex
CREATE INDEX "events_index_event_types_idx" ON "events_index" USING GIN ("event_types");

-- CreateIndex
CREATE INDEX "events_index_time_range_start_time_range_end_idx" ON "events_index"("time_range_start", "time_range_end");

-- CreateIndex
-- Recency ordering for the frame-mode incident band (ADR-0006 §4).
CREATE INDEX "events_index_started_at_idx" ON "events_index"("started_at");

-- ─── Raw-SQL additions Prisma can't express ─────────────────────────

-- HNSW index for approximate k-NN over the 1024-dim embedding. Cosine ops
-- matches the caller's search path (`embedding <=> $1`). m=16 / ef_construction=64
-- are pgvector defaults — same as knowledgebase.
CREATE INDEX "events_index_embedding_hnsw_idx"
    ON "events_index"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- GIN index for BM25/lexical rank queries against the tsvector column.
CREATE INDEX "events_index_lexical_tsv_idx"
    ON "events_index"
    USING GIN ("lexical_tsv");

-- Keep `lexical_tsv` in sync with `embedded_text` (English-only POC, like
-- knowledgebase; becomes locale-aware when Arabic/French are added).
CREATE TRIGGER "events_index_lexical_tsv_trigger"
    BEFORE INSERT OR UPDATE OF "embedded_text" ON "events_index"
    FOR EACH ROW
    EXECUTE FUNCTION tsvector_update_trigger("lexical_tsv", 'pg_catalog.english', "embedded_text");
