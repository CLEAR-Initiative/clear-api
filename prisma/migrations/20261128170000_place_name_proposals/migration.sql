-- Place proposals (ADR-0019 and ADR-0010 amendments, decision D-0296,
-- Exponential #1722). The typed result of one place research Task
-- (`place_name.locate.web`): one row per completed Task, beside the queue row
-- that it answers. Additive: no existing column changes.

-- CreateTable
CREATE TABLE "place_name_proposals" (
    "id" TEXT NOT NULL,
    "unresolved_place_name_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "name_found" TEXT,
    "confidence" TEXT,
    "reason" TEXT NOT NULL,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "method_version" TEXT NOT NULL,
    "used_by_id" TEXT,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "place_name_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "place_name_proposals_task_id_key" ON "place_name_proposals"("task_id");

-- CreateIndex
CREATE INDEX "place_name_proposals_unresolved_place_name_id_created_at_idx" ON "place_name_proposals"("unresolved_place_name_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "place_name_proposals" ADD CONSTRAINT "place_name_proposals_unresolved_place_name_id_fkey" FOREIGN KEY ("unresolved_place_name_id") REFERENCES "unresolved_place_names"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_name_proposals" ADD CONSTRAINT "place_name_proposals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Value sets, as on the queue tables (ADR-0019 point 12).
ALTER TABLE "place_name_proposals"
    ADD CONSTRAINT "place_name_proposals_outcome_check"
        CHECK ("outcome" IN ('found', 'not_found', 'not_a_place'));
ALTER TABLE "place_name_proposals"
    ADD CONSTRAINT "place_name_proposals_confidence_check"
        CHECK ("confidence" IS NULL OR "confidence" IN ('high', 'medium', 'low'));

-- A "found" proposal carries a whole point; the other outcomes carry none.
ALTER TABLE "place_name_proposals"
    ADD CONSTRAINT "place_name_proposals_point_check"
        CHECK (
            ("outcome" = 'found'
                AND "latitude" IS NOT NULL AND "longitude" IS NOT NULL
                AND "name_found" IS NOT NULL AND "confidence" IS NOT NULL)
            OR
            ("outcome" <> 'found'
                AND "latitude" IS NULL AND "longitude" IS NULL
                AND "name_found" IS NULL AND "confidence" IS NULL)
        );
