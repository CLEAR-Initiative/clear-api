-- The replay series reads one run's Outcomes Signal by Signal, and the run
-- list groups by run (ADR-0020). Live Outcomes have a run id too, so the
-- index is on every row.

-- CreateIndex
CREATE INDEX "signal_location_outcomes_run_id_signal_id_idx" ON "signal_location_outcomes"("run_id", "signal_id");
