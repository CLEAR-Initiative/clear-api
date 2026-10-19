-- Adds signal retraction (retracted, revision) and event recompute support
-- (NEEDS_RECOMPUTE, rewrite_members_hash). The new signals columns use constant
-- defaults, which are metadata-only: existing rows read false / 0.

-- AlterEnum
-- Safe in a transaction (PostgreSQL >= 12) because the value is not used here.
ALTER TYPE "SignalStatus" ADD VALUE 'NEEDS_RECOMPUTE';

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "rewrite_members_hash" TEXT;

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "retracted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;
