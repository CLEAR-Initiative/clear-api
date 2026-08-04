-- AlterTable
ALTER TABLE "data_sources" ADD COLUMN     "reliability" INTEGER,
ADD COLUMN     "synonyms" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "report_datapoints" ADD COLUMN     "source_id" TEXT;

-- CreateIndex
CREATE INDEX "report_datapoints_source_id_idx" ON "report_datapoints"("source_id");

-- AddForeignKey
ALTER TABLE "report_datapoints" ADD CONSTRAINT "report_datapoints_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
