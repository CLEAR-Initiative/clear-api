-- Durable "approved self-signup" marker for the CRM sync (Exponential #1478).
-- approveUserById sets it in the same UPDATE as the pending → member flip;
-- before this it was only recorded in a best-effort activity-log row.

-- AlterTable
ALTER TABLE "user" ADD COLUMN "approved_at" TIMESTAMP(3);

-- Backfill from the approval log: the earliest `user.approved` row per user.
UPDATE "user" u
SET "approved_at" = a.approved_at
FROM (
  SELECT "resource_id", MIN("created_at") AS approved_at
  FROM "activity_logs"
  WHERE "action" = 'user.approved' AND "resource_type" = 'user' AND "resource_id" IS NOT NULL
  GROUP BY "resource_id"
) a
WHERE u."id" = a."resource_id";
