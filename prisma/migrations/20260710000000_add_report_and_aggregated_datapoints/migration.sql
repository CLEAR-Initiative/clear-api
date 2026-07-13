-- Structured humanitarian datapoints — per-report + pre-aggregated.
-- Powers Layers 1 and 2 of the read path (see
-- docs/humanitarian-datapoint-extraction.md).
--
-- Nothing exotic in the DDL: JSONB blobs for the exhaustive payloads,
-- typed hot columns for cheap dashboard filter/sort, GIN indexes on
-- the array columns to make locations / event-type overlap queries
-- fast without opening the JSONB.

-- CreateTable
CREATE TABLE "report_datapoints" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "report_title" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL,
    "reporting_period_start" TIMESTAMP(3),
    "reporting_period_end" TIMESTAMP(3),
    "location_ids" TEXT[],
    "location_pcodes" TEXT[],
    "event_types" TEXT[],
    "total_affected" INTEGER,
    "total_displaced" INTEGER,
    "total_killed" INTEGER,
    "data" JSONB NOT NULL,
    "schema_version" TEXT NOT NULL,
    "extracted_by_model" TEXT NOT NULL,
    "extracted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_datapoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aggregated_datapoints" (
    "id" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "window_kind" TEXT NOT NULL,
    "location_id" TEXT,
    "data" JSONB NOT NULL,
    "contributing_report_ids" TEXT[],
    "newest_source_at" TIMESTAMP(3) NOT NULL,
    "oldest_source_at" TIMESTAMP(3) NOT NULL,
    "data_quality_score" DOUBLE PRECISION NOT NULL,
    "report_count" INTEGER NOT NULL,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,
    "schema_version" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aggregated_datapoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_datapoints_report_id_key" ON "report_datapoints"("report_id");

-- CreateIndex
CREATE INDEX "report_datapoints_reporting_period_start_reporting_period_e_idx" ON "report_datapoints"("reporting_period_start", "reporting_period_end");

-- CreateIndex
CREATE INDEX "report_datapoints_location_ids_idx" ON "report_datapoints" USING GIN ("location_ids");

-- CreateIndex
CREATE INDEX "report_datapoints_event_types_idx" ON "report_datapoints" USING GIN ("event_types");

-- CreateIndex
CREATE INDEX "report_datapoints_schema_version_idx" ON "report_datapoints"("schema_version");

-- CreateIndex
CREATE INDEX "aggregated_datapoints_location_id_window_start_idx" ON "aggregated_datapoints"("location_id", "window_start");

-- CreateIndex
CREATE INDEX "aggregated_datapoints_is_stale_idx" ON "aggregated_datapoints"("is_stale");

-- CreateIndex
CREATE UNIQUE INDEX "aggregated_datapoints_window_start_window_end_window_kind_l_key" ON "aggregated_datapoints"("window_start", "window_end", "window_kind", "location_id", "schema_version");
