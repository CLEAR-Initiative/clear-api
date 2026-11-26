-- Decision records V1 (ADR-0024, Exponential #585): one append-only row per
-- human judgement, written in the same transaction as the change. Nothing
-- here touches existing rows: the table starts empty and the new Signal
-- column is nullable.

CREATE TYPE "decision_type" AS ENUM (
    'CASE_PROPOSAL_DECIDED',
    'SIGNAL_LOCATION_DECIDED',
    'SIGNAL_SEVERITY_SET'
);

CREATE TABLE "decision_records" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "decision_type" "decision_type" NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "via_agent" BOOLEAN NOT NULL DEFAULT false,
    "rationale" TEXT,
    "evidence_cited" JSONB,
    "payload" JSONB NOT NULL,
    "supersedes_id" TEXT,
    "correlation_id" TEXT,
    "client_request_id" TEXT,
    "definition_version" TEXT NOT NULL,

    CONSTRAINT "decision_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "decision_records_sequence_key" ON "decision_records"("sequence");
CREATE INDEX "decision_records_subject_type_subject_id_sequence_idx"
    ON "decision_records"("subject_type", "subject_id", "sequence");

-- A deleted user's decisions stay; only the reference is cleared.
ALTER TABLE "decision_records"
    ADD CONSTRAINT "decision_records_decided_by_fkey"
    FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "decision_records"
    ADD CONSTRAINT "decision_records_supersedes_id_fkey"
    FOREIGN KEY ("supersedes_id") REFERENCES "decision_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Set when a person sets the severity; a pipeline write then keeps it.
ALTER TABLE "signals" ADD COLUMN "severity_corrected_at" TIMESTAMP(3);
