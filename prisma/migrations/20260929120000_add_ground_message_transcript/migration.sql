-- ground_messages.transcript was added to schema.prisma alongside the
-- ground_threads draft_* columns but missed from
-- 20260922104132_add_ground_thread_drafts. Added as its own migration so
-- databases that already applied that one don't hit a checksum mismatch.

-- AlterTable
ALTER TABLE "ground_messages" ADD COLUMN "transcript" TEXT;
