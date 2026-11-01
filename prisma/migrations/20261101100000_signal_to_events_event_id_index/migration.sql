-- The grouping and recall proxies (ADR-0018) and the first-ingested-Signal
-- CTEs look links up by Event; the unique (signal_id, event_id) index serves
-- lookups by Signal only, so a lookup by Event scanned the table once per row.
CREATE INDEX "signal_to_events_event_id_idx" ON "signal_to_events"("event_id");
