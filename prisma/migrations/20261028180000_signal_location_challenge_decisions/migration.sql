-- Location challenges become decisions (Exponential #836): each is filed for a
-- team, and that team's admin accepts it (writing the point onto the Signal),
-- places a different point, or declines it. Existing rows are all open
-- ("consideration") and stay open with no team.
ALTER TABLE "signal_location_challenges"
    ADD COLUMN "team_id" TEXT,
    ADD COLUMN "previous_location_id" TEXT,
    ADD COLUMN "applied_location_id" TEXT,
    ADD COLUMN "decided_by" TEXT,
    ADD COLUMN "decided_at" TIMESTAMP(3);

-- At most one open challenge per Signal (a new one supersedes it), while
-- decided ones accumulate as history: the full unique key on
-- (signal_id, status) allowed only one accepted and one declined row per
-- Signal, ever. Partial, so not expressible in Prisma.
DROP INDEX "signal_location_challenges_signal_id_status_key";
CREATE UNIQUE INDEX "signal_location_challenges_one_open_key"
    ON "signal_location_challenges"("signal_id") WHERE "status" = 'consideration';

-- CreateIndex
CREATE INDEX "signal_location_challenges_team_id_status_created_at_idx"
    ON "signal_location_challenges"("team_id", "status", "created_at");

-- Status invariant (the resolver writes the same set).
ALTER TABLE "signal_location_challenges"
    ADD CONSTRAINT "signal_location_challenges_status_check"
        CHECK ("status" IN ('consideration', 'accepted', 'corrected', 'declined', 'superseded'));

-- AddForeignKey
ALTER TABLE "signal_location_challenges" ADD CONSTRAINT "signal_location_challenges_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_location_challenges" ADD CONSTRAINT "signal_location_challenges_previous_location_id_fkey" FOREIGN KEY ("previous_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_location_challenges" ADD CONSTRAINT "signal_location_challenges_applied_location_id_fkey" FOREIGN KEY ("applied_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A person corrected the Signal's location: source revisions keep it.
ALTER TABLE "signals" ADD COLUMN "location_corrected_at" TIMESTAMP(3);
