-- Review fix A6: dedupe PENDING analysis requests per frame + serve the ordered
-- pendingAnalyses drain. Split into its own migration because
-- 20260922000000_add_analysis_and_automation was already applied (Prisma
-- migrations are immutable once run). Idempotent (IF EXISTS / IF NOT EXISTS) so
-- it is safe regardless of whether an environment already has these indexes.

-- The plain status index is superseded by the (status, created_at) composite.
DROP INDEX IF EXISTS "analysis_requests_status_idx";

CREATE INDEX IF NOT EXISTS "analysis_requests_status_created_at_idx"
  ON "analysis_requests"("status", "created_at");

-- At most one PENDING request per frame — the resolver's findFirst-then-create
-- is a TOCTOU race without this (two concurrent identical requests → double
-- generation). NULLS NOT DISTINCT so rolling frames (window_end NULL) dedupe;
-- partial WHERE status='PENDING' so GENERATED/FAILED history rows don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_requests_pending_frame_uk"
  ON "analysis_requests"("location_ids", "event_types", "need_sectors", "window_start", "window_end")
  NULLS NOT DISTINCT
  WHERE "status" = 'PENDING';
