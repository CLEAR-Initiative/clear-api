-- AlterTable
ALTER TABLE "user_comments" ADD COLUMN     "analysis_automation_id" TEXT;

-- AlterTable
ALTER TABLE "analysis_automations" ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "analysis_automation_documents" (
    "id" TEXT NOT NULL,
    "analysis_automation_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "uploaded_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_automation_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_automation_documents_analysis_automation_id_idx" ON "analysis_automation_documents"("analysis_automation_id");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_automation_documents_analysis_automation_id_report_key" ON "analysis_automation_documents"("analysis_automation_id", "report_id");

-- CreateIndex
CREATE INDEX "user_comments_analysis_automation_id_idx" ON "user_comments"("analysis_automation_id");

-- AddForeignKey
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_analysis_automation_id_fkey" FOREIGN KEY ("analysis_automation_id") REFERENCES "analysis_automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_automation_documents" ADD CONSTRAINT "analysis_automation_documents_analysis_automation_id_fkey" FOREIGN KEY ("analysis_automation_id") REFERENCES "analysis_automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
