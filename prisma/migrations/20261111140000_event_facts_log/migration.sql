-- Replay-safe history for the alert and detection metrics (ADR-0021):
-- the Event facts log, the onset an Alert was raised on, and the kind of run
-- that created an Event or raised an Alert.

-- AlterTable
ALTER TABLE "events" ADD COLUMN "created_by_run_kind" "LocationRunKind";

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN "onset_at_raise" TIMESTAMP(3),
ADD COLUMN "onset_accuracy_at_raise" "DateAccuracy",
ADD COLUMN "raised_by_run_kind" "LocationRunKind";

-- CreateTable
CREATE TABLE "event_facts_log" (
    "id" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "started_at_accuracy" "DateAccuracy",
    "first_signal_created_at" TIMESTAMP(3) NOT NULL,
    "location_id" TEXT,
    "location_district_id" TEXT,
    "origin_id" TEXT,
    "origin_district_id" TEXT,
    "destination_id" TEXT,
    "destination_district_id" TEXT,
    "run_kind" "LocationRunKind" NOT NULL DEFAULT 'LIVE',
    "pipeline_version" TEXT,
    "run_id" TEXT,

    CONSTRAINT "event_facts_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_facts_log_event_id_run_kind_id_idx" ON "event_facts_log"("event_id", "run_kind", "id");

-- CreateIndex
CREATE INDEX "event_facts_log_run_id_idx" ON "event_facts_log"("run_id");

-- Backfill 1: one LIVE row per existing Event, with its current facts. No
-- replay has written an Event yet, so the current facts are the Live result.
-- The district of a place is the level-2 location among the place and its
-- ancestors, as "ACLED events alerted nearby" read it until now.
INSERT INTO "event_facts_log" (
  "event_id", "recorded_at", "started_at", "started_at_accuracy", "first_signal_created_at",
  "location_id", "location_district_id", "origin_id", "origin_district_id",
  "destination_id", "destination_district_id", "run_kind"
)
SELECT e."id", (now() AT TIME ZONE 'UTC'), e."started_at", e."started_at_accuracy", e."first_signal_created_at",
  e."location_id",
  CASE WHEN gl."level" = 2 THEN gl."id"
    ELSE (SELECT d."id" FROM "locations" d WHERE d."level" = 2 AND d."id" = ANY(gl."ancestor_ids") LIMIT 1) END,
  e."origin_id",
  CASE WHEN ol."level" = 2 THEN ol."id"
    ELSE (SELECT d."id" FROM "locations" d WHERE d."level" = 2 AND d."id" = ANY(ol."ancestor_ids") LIMIT 1) END,
  e."destination_id",
  CASE WHEN dl."level" = 2 THEN dl."id"
    ELSE (SELECT d."id" FROM "locations" d WHERE d."level" = 2 AND d."id" = ANY(dl."ancestor_ids") LIMIT 1) END,
  'LIVE'
FROM "events" e
LEFT JOIN "locations" gl ON gl."id" = e."location_id"
LEFT JOIN "locations" ol ON ol."id" = e."origin_id"
LEFT JOIN "locations" dl ON dl."id" = e."destination_id";

-- Backfill 2: the current onset onto each existing Alert. When the Alert was
-- raised is the best instant we have for "the onset it was raised on": the
-- onset then was not kept. Time to alert does not move at the switch.
UPDATE "alerts" a
SET "onset_at_raise" = e."started_at", "onset_accuracy_at_raise" = e."started_at_accuracy"
FROM "events" e
WHERE e."id" = a."event_id";

-- Backfill 3: LIVE on every existing Event that holds a Signal a pipeline
-- brought in. No replay has created an Event yet. An Event with only web
-- cases or hand-filed Signals stays null: a person created it.
UPDATE "events" e
SET "created_by_run_kind" = 'LIVE'
WHERE EXISTS (
  SELECT 1 FROM "signal_to_events" se
  JOIN "signals" s ON s."id" = se."signal_id"
  WHERE se."event_id" = e."id"
    AND s."submitted_by_id" IS NULL
    AND s."raw_data"->>'manual' IS DISTINCT FROM 'true'
);
