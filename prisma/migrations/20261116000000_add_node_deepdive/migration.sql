-- Node deep-dive (analysis-node-deepdive): on-demand generation of INDIVIDUAL
-- taxonomy nodes (L2/L3 leaves) beyond the default L1 situation.
--   1. The on-demand request carries the selected taxonomy node keys.
--   2. A new per-(frame, node) results table surfaces each node independently.
-- Hand-authored because the partial / NULLS-NOT-DISTINCT unique indexes can't be
-- expressed in schema.prisma. Idempotent (IF [NOT] EXISTS) so re-applying across
-- environments is safe.

-- 1. Selection on the on-demand request queue. Empty array = the default L1
--    situation fan-out (unchanged behaviour). Default so existing PENDING rows
--    backfill to "no selection".
ALTER TABLE "analysis_requests"
  ADD COLUMN IF NOT EXISTS "taxonomy_node_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The PENDING-per-frame dedupe now includes the node selection, so two different
-- deep-dive selections for the same frame are distinct requests (not deduped),
-- while two identical selections still collapse. Recreate the partial unique.
DROP INDEX IF EXISTS "analysis_requests_pending_frame_uk";
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_requests_pending_frame_uk"
  ON "analysis_requests"("location_ids", "event_types", "need_sectors", "window_start", "window_end", "taxonomy_node_keys")
  NULLS NOT DISTINCT
  WHERE "status" = 'PENDING';

-- 2. Per-node results — the frame-scoped sibling of `analyses`, at taxonomy-node
--    granularity. Bitemporal (valid_from / valid_to); one current row per
--    (frame, node_key, schema_version).
CREATE TABLE IF NOT EXISTS "node_analyses" (
    "id" TEXT NOT NULL,
    "location_ids" TEXT[],
    "event_types" TEXT[],
    "need_sectors" TEXT[],
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3),
    "node_key" TEXT NOT NULL,
    "node_name" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "source_report_ids" TEXT[],
    "generated_by_model" TEXT NOT NULL,
    "generation_cost_usd" DOUBLE PRECISION,
    "generation_input_tokens" INTEGER,
    "generation_output_tokens" INTEGER,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "schema_version" TEXT NOT NULL,

    CONSTRAINT "node_analyses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "node_analyses_valid_to_idx" ON "node_analyses"("valid_to");
CREATE INDEX IF NOT EXISTS "node_analyses_schema_version_idx" ON "node_analyses"("schema_version");
CREATE INDEX IF NOT EXISTS "node_analyses_node_key_idx" ON "node_analyses"("node_key");
CREATE INDEX IF NOT EXISTS "node_analyses_location_ids_idx" ON "node_analyses" USING GIN ("location_ids");
CREATE INDEX IF NOT EXISTS "node_analyses_event_types_idx" ON "node_analyses" USING GIN ("event_types");
CREATE INDEX IF NOT EXISTS "node_analyses_need_sectors_idx" ON "node_analyses" USING GIN ("need_sectors");

-- One CURRENT row per (frame, node, schema_version). NULLS NOT DISTINCT so a
-- rolling frame (window_end NULL) dedupes; history rows (valid_to NOT NULL) do
-- not participate. Array identity relies on the resolver canonicalising on write.
CREATE UNIQUE INDEX IF NOT EXISTS "node_analyses_current_frame_node_uk"
  ON "node_analyses"("location_ids", "event_types", "need_sectors", "window_start", "window_end", "node_key", "schema_version")
  NULLS NOT DISTINCT
  WHERE "valid_to" IS NULL;
