-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'LEASED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskOrigin" AS ENUM ('user', 'rule', 'api');

-- CreateEnum
CREATE TYPE "ImpactPriorState" AS ENUM ('proposed', 'accepted', 'rejected');

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "origin" "TaskOrigin" NOT NULL DEFAULT 'user',
    "requester_id" TEXT,
    "team_id" TEXT,
    "lease_owner_id" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "last_error" TEXT,
    "cancel_requested_at" TIMESTAMP(3),
    "cancelled_by_id" TEXT,
    "outcome" TEXT,
    "result" JSONB,
    "model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impact_priors" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "state" "ImpactPriorState" NOT NULL DEFAULT 'proposed',
    "hazard_type" TEXT NOT NULL,
    "country_location_id" TEXT NOT NULL,
    "geographic_scope" TEXT NOT NULL,
    "horizon_years" INTEGER NOT NULL,
    "population_group" TEXT,
    "metric" TEXT,
    "lower_bound" DOUBLE PRECISION,
    "upper_bound" DOUBLE PRECISION,
    "number_of_cases" INTEGER NOT NULL,
    "basis" JSONB NOT NULL,
    "valid_from" TIMESTAMP(3),
    "valid_to" TIMESTAMP(3),
    "method_version" TEXT NOT NULL,
    "supersedes_id" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_rationale" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impact_priors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_status_kind_created_at_idx" ON "tasks"("status", "kind", "created_at");

-- CreateIndex
CREATE INDEX "tasks_subject_type_subject_id_idx" ON "tasks"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "tasks_requester_id_created_at_idx" ON "tasks"("requester_id", "created_at");

-- CreateIndex
CREATE INDEX "impact_priors_event_id_created_at_idx" ON "impact_priors"("event_id", "created_at");

-- CreateIndex
CREATE INDEX "impact_priors_state_created_at_idx" ON "impact_priors"("state", "created_at");

-- AddForeignKey
ALTER TABLE "impact_priors" ADD CONSTRAINT "impact_priors_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "impact_priors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impact_priors" ADD CONSTRAINT "impact_priors_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impact_priors" ADD CONSTRAINT "impact_priors_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one open (PENDING or LEASED) Task per (kind, subject). The
-- resolver's findFirst-then-create in `requestEventEnrichment` is a TOCTOU
-- race without this (two concurrent requests → two Tasks for one Event);
-- partial so COMPLETED / FAILED / CANCELLED history rows never collide.
-- SQL-only: Prisma can't express partial indexes (same as
-- analysis_requests_pending_frame_uk).
CREATE UNIQUE INDEX "tasks_open_subject_uk"
  ON "tasks"("kind", "subject_type", "subject_id")
  WHERE "status" IN ('PENDING', 'LEASED');
