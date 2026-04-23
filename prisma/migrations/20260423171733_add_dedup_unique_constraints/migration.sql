/*
  Warnings:

  - A unique constraint covering the columns `[event_id]` on the table `alerts` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[signal_id,event_id]` on the table `signal_to_events` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "alerts_event_id_key" ON "alerts"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_to_events_signal_id_event_id_key" ON "signal_to_events"("signal_id", "event_id");
