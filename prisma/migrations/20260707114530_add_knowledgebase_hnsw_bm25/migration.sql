-- Knowledge base for hybrid (dense vector + BM25 lexical) retrieval over
-- ReliefWeb PDFs. Prisma-generated DDL for the standard columns +
-- hand-written DDL for the pieces Prisma cannot express (HNSW index on
-- pgvector, tsvector trigger, GIN index on the tsvector column).
--
-- IMPORTANT: schema.prisma has `Unsupported("vector(1024)")` and
-- `Unsupported("tsvector")` fields with docstrings requiring their
-- preservation. Do NOT drop those fields — doing so would cascade the
-- HNSW index. Future migrations should always be generated with
-- `prisma migrate diff --from-migrations`, never `prisma db pull`
-- (introspection loses the HNSW index).

CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "knowledgebase" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "report_title" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "page_start" INTEGER NOT NULL,
    "page_end" INTEGER NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "context_prefix" TEXT NOT NULL,
    "embedded_text" TEXT NOT NULL,
    "embedding_provider" TEXT NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "lexical_tsv" tsvector NOT NULL,
    "location_ids" TEXT[],
    "location_pcodes" TEXT[],
    "time_range_start" TIMESTAMP(3),
    "time_range_end" TIMESTAMP(3),
    "event_types" TEXT[],
    "need_sectors" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledgebase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledgebase_report_id_idx" ON "knowledgebase"("report_id");

-- CreateIndex
CREATE INDEX "knowledgebase_embedding_model_idx" ON "knowledgebase"("embedding_model");

-- CreateIndex
CREATE INDEX "knowledgebase_location_ids_idx" ON "knowledgebase" USING GIN ("location_ids");

-- CreateIndex
CREATE INDEX "knowledgebase_event_types_idx" ON "knowledgebase" USING GIN ("event_types");

-- CreateIndex
CREATE INDEX "knowledgebase_need_sectors_idx" ON "knowledgebase" USING GIN ("need_sectors");

-- CreateIndex
CREATE INDEX "knowledgebase_time_range_start_time_range_end_idx" ON "knowledgebase"("time_range_start", "time_range_end");

-- CreateIndex
CREATE UNIQUE INDEX "knowledgebase_report_id_chunk_index_key" ON "knowledgebase"("report_id", "chunk_index");

-- ─── Raw-SQL additions Prisma can't express ─────────────────────────

-- HNSW index for approximate k-NN over the 1024-dim embedding. Cosine
-- ops matches the caller's search path (`embedding <=> $1`) — swapping
-- to L2 (`vector_l2_ops` + `<->`) would silently break recall until the
-- index is rebuilt. m=16 / ef_construction=64 are pgvector defaults;
-- tune if recall/latency needs shift.
CREATE INDEX "knowledgebase_embedding_hnsw_idx"
    ON "knowledgebase"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- GIN index for BM25/lexical rank queries against the tsvector column.
-- Populated by the trigger below.
CREATE INDEX "knowledgebase_lexical_tsv_idx"
    ON "knowledgebase"
    USING GIN ("lexical_tsv");

-- Keep `lexical_tsv` in sync with `embedded_text`. Using the built-in
-- `tsvector_update_trigger` so we don't need to define a custom
-- function — `pg_catalog.english` is fine for the initial POC (English
-- only). When Arabic/French locales are added the config argument here
-- becomes locale-aware and this trigger flips to a custom function.
CREATE TRIGGER "knowledgebase_lexical_tsv_trigger"
    BEFORE INSERT OR UPDATE OF "embedded_text" ON "knowledgebase"
    FOR EACH ROW
    EXECUTE FUNCTION tsvector_update_trigger("lexical_tsv", 'pg_catalog.english', "embedded_text");
