-- CreateTable
CREATE TABLE "analysis_datapoints" (
    "id" TEXT NOT NULL,
    "analysis_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "contributing_report_ids" TEXT[],
    "origin" TEXT,
    "newest_source_at" TIMESTAMP(3),
    "oldest_source_at" TIMESTAMP(3),
    "data_quality_score" DOUBLE PRECISION,
    "report_count" INTEGER,
    "schema_version" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_datapoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analysis_datapoints_analysis_id_key" ON "analysis_datapoints"("analysis_id");

-- AddForeignKey
ALTER TABLE "analysis_datapoints"
    ADD CONSTRAINT "analysis_datapoints_analysis_id_fkey"
    FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
