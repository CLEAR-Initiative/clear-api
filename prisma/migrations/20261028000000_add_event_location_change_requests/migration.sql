-- CreateTable
CREATE TABLE "event_location_change_requests" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "proposed_lat" DOUBLE PRECISION NOT NULL,
    "proposed_lng" DOUBLE PRECISION NOT NULL,
    "proposed_name" TEXT NOT NULL,
    "previous_location_id" TEXT,
    "applied_location_id" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,

    CONSTRAINT "event_location_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_location_change_requests_team_id_status_created_at_idx" ON "event_location_change_requests"("team_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "event_location_change_requests_event_id_idx" ON "event_location_change_requests"("event_id");

-- At most one pending request per event and team: a re-proposal replaces the
-- open one (the resolver updates it). Partial, so not expressible in Prisma.
CREATE UNIQUE INDEX "event_location_change_requests_one_pending_key"
    ON "event_location_change_requests"("event_id", "team_id") WHERE "status" = 'pending';

-- Status and coordinate invariants (the resolver enforces the same rules).
ALTER TABLE "event_location_change_requests"
    ADD CONSTRAINT "event_location_change_requests_status_check"
        CHECK ("status" IN ('pending', 'accepted', 'rejected')),
    ADD CONSTRAINT "event_location_change_requests_point_range"
        CHECK ("proposed_lat" BETWEEN -90 AND 90 AND "proposed_lng" BETWEEN -180 AND 180);

-- AddForeignKey
ALTER TABLE "event_location_change_requests" ADD CONSTRAINT "event_location_change_requests_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_location_change_requests" ADD CONSTRAINT "event_location_change_requests_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_location_change_requests" ADD CONSTRAINT "event_location_change_requests_previous_location_id_fkey" FOREIGN KEY ("previous_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_location_change_requests" ADD CONSTRAINT "event_location_change_requests_applied_location_id_fkey" FOREIGN KEY ("applied_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

