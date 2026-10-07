-- Several Workers propose on one Event (ADR-0010, V3). One enrichment request
-- now fans out into one Task per source kind (event.impact_prior.clear,
-- event.impact_prior.web, ...), so:
--
-- * tasks.request_id groups the Tasks of one request; the per-requester daily
--   cap counts distinct requests, not rows. Every existing Task was a request
--   of its own.
-- * impact_priors.source_kind records which kind produced a proposal, so the
--   UI can label it and completeTask supersedes within a source kind only.
--   Backfilled from the producing Task (every prior has one; the FK is
--   RESTRICT).

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "request_id" TEXT;
UPDATE "tasks" SET "request_id" = "id";
ALTER TABLE "tasks" ALTER COLUMN "request_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "impact_priors" ADD COLUMN "source_kind" TEXT;
UPDATE "impact_priors" ip SET "source_kind" = t."kind" FROM "tasks" t WHERE t."id" = ip."task_id";
ALTER TABLE "impact_priors" ALTER COLUMN "source_kind" SET NOT NULL;
