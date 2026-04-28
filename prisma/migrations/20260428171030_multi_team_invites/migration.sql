-- CreateTable
CREATE TABLE "invitation_teams" (
    "id" TEXT NOT NULL,
    "invitation_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "team_role" TEXT NOT NULL,

    CONSTRAINT "invitation_teams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invitation_teams_team_id_idx" ON "invitation_teams"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_teams_invitation_id_team_id_key" ON "invitation_teams"("invitation_id", "team_id");

-- AddForeignKey
ALTER TABLE "invitation_teams" ADD CONSTRAINT "invitation_teams_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_teams" ADD CONSTRAINT "invitation_teams_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
