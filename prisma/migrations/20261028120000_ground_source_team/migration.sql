-- Scope hotline/ground sources to a team: a team's ERMs see only the threads
-- of the sources assigned to that team. NULL = unassigned (platform admins only).
ALTER TABLE "ground_sources" ADD COLUMN "team_id" TEXT;

CREATE INDEX "ground_sources_team_id_idx" ON "ground_sources"("team_id");

ALTER TABLE "ground_sources" ADD CONSTRAINT "ground_sources_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
