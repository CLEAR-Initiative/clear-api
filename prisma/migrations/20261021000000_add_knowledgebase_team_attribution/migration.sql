-- AlterTable
ALTER TABLE "knowledgebase" ADD COLUMN     "team_id" TEXT,
ADD COLUMN     "uploaded_by_user_id" TEXT;

-- CreateIndex
CREATE INDEX "knowledgebase_team_id_idx" ON "knowledgebase"("team_id");
