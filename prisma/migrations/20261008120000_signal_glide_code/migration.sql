-- Adds the glide code the pipeline grouped each signal with, so an event
-- recompute can reproduce grouping's per-signal stats fallback. Nullable, no
-- default: metadata-only, existing rows read null.

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "glide_code" TEXT;
