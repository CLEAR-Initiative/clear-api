-- Per-case review (ADR-0010 amendment, V4). A web Worker's evidence becomes
-- one row per case — the unit an analyst accepts or rejects — instead of a
-- JSON array inside one ImpactPrior that could only be decided whole.
--
-- The backfill copies the web cases of every still-proposed ImpactPrior into
-- case_proposals, so they reach the per-case Inbox. The ImpactPrior rows stay
-- as they are (history); the Inbox stops listing web proposals.

-- CreateEnum
CREATE TYPE "CaseProposalState" AS ENUM ('proposed', 'accepted', 'rejected');

-- CreateTable
CREATE TABLE "case_proposals" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "state" "CaseProposalState" NOT NULL DEFAULT 'proposed',
    "source_url" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "location_label" TEXT NOT NULL,
    "location_id" TEXT,
    "hazard_type" TEXT NOT NULL,
    "geographic_scope" TEXT NOT NULL,
    "figures" JSONB NOT NULL DEFAULT '[]',
    "matched_event_id" TEXT,
    "method_version" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_rationale" TEXT,
    "result_signal_id" TEXT,
    "result_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "case_proposals_state_created_at_idx" ON "case_proposals"("state", "created_at");

-- CreateIndex
CREATE INDEX "case_proposals_task_id_idx" ON "case_proposals"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "case_proposals_event_id_source_url_key" ON "case_proposals"("event_id", "source_url");

-- AddForeignKey
ALTER TABLE "case_proposals" ADD CONSTRAINT "case_proposals_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_proposals" ADD CONSTRAINT "case_proposals_matched_event_id_fkey" FOREIGN KEY ("matched_event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_proposals" ADD CONSTRAINT "case_proposals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Signals record who submitted them (the Domain Ontology's submitted_by_user):
-- accepting a web case writes a Signal the analyst vouched for.
ALTER TABLE "signals" ADD COLUMN "submitted_by_id" TEXT;
ALTER TABLE "signals" ADD CONSTRAINT "signals_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The source of every Signal written by accepting a web case. One row, found
-- by name; created here so the accept path never has to.
INSERT INTO "data_sources" ("id", "name", "type", "is_active", "updated_at")
SELECT 'web_enrichment', 'web_enrichment', 'web', true, now()
WHERE NOT EXISTS (SELECT 1 FROM "data_sources" WHERE "name" = 'web_enrichment');

-- Backfill: the web cases of still-proposed ImpactPriors. A case without a
-- URL or a parseable date cannot be decided or written into CLEAR, so it is
-- left behind on its ImpactPrior. A URL already proposed for the Event is
-- skipped (one proposal per source per Event).
CREATE FUNCTION pg_temp.case_ts(value TEXT) RETURNS TIMESTAMP(3) LANGUAGE plpgsql AS $$
BEGIN
  RETURN (value::timestamptz AT TIME ZONE 'UTC')::timestamp(3);
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

INSERT INTO "case_proposals" (
  "id", "event_id", "task_id", "state", "source_url", "quote", "occurred_at",
  "location_label", "hazard_type", "geographic_scope", "figures", "method_version", "created_at"
)
SELECT
  'cp' || replace(gen_random_uuid()::text, '-', ''),
  ip."event_id",
  ip."task_id",
  'proposed',
  btrim(c ->> 'sourceUrl'),
  COALESCE(c ->> 'quote', ''),
  pg_temp.case_ts(c ->> 'occurredAt'),
  COALESCE(c ->> 'locationLabel', ''),
  ip."hazard_type",
  CASE WHEN c ->> 'scope' IN ('district', 'country') THEN c ->> 'scope' ELSE ip."geographic_scope" END,
  '[]'::jsonb,
  ip."method_version",
  ip."created_at"
FROM "impact_priors" ip
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(ip."basis") = 'array' THEN ip."basis" ELSE '[]'::jsonb END
) AS c
WHERE ip."state" = 'proposed'
  AND c ->> 'tier' = 'web'
  AND btrim(COALESCE(c ->> 'sourceUrl', '')) <> ''
  AND pg_temp.case_ts(c ->> 'occurredAt') IS NOT NULL
ORDER BY ip."created_at" DESC
ON CONFLICT ("event_id", "source_url") DO NOTHING;
