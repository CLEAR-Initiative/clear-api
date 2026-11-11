-- The grouping log (ADR-0021): one row per Link that a pipeline run makes
-- between a Signal and an Event. Append-only. "Signals grouped" and "Events
-- with one Signal" read the LIVE rows, so a re-grouping replay adds REPLAY
-- rows and changes no history.

-- CreateTable
CREATE TABLE "signal_grouping_log" (
    "id" BIGSERIAL NOT NULL,
    "signal_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL,
    "run_kind" "LocationRunKind" NOT NULL DEFAULT 'LIVE',
    "pipeline_version" TEXT,
    "run_id" TEXT,

    CONSTRAINT "signal_grouping_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signal_grouping_log_signal_id_run_kind_idx" ON "signal_grouping_log"("signal_id", "run_kind");

-- CreateIndex
CREATE INDEX "signal_grouping_log_event_id_run_kind_linked_at_idx" ON "signal_grouping_log"("event_id", "run_kind", "linked_at");

-- CreateIndex
CREATE INDEX "signal_grouping_log_run_id_idx" ON "signal_grouping_log"("run_id");

-- AddForeignKey
ALTER TABLE "signal_grouping_log" ADD CONSTRAINT "signal_grouping_log_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one LIVE row per existing Link, at the instant of the Link. No
-- replay has made a Link yet, so every Link is a Live result. A Link that a
-- person made gets a row too: the table does not say who made a Link, and the
-- metrics counted these Links until now. Retracted and dummy Signals get a
-- row: both flags can change later, and the metrics filter on them when they
-- read. The series do not move at the switch.
INSERT INTO "signal_grouping_log" ("signal_id", "event_id", "linked_at", "run_kind")
SELECT se."signal_id", se."event_id", se."collected_at", 'LIVE'
FROM "signal_to_events" se;
