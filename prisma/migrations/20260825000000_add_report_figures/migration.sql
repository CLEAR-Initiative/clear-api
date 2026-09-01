-- CreateTable
CREATE TABLE "report_figures" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "report_title" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "page_number" INTEGER NOT NULL,
    "bbox" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "is_full_page" BOOLEAN NOT NULL DEFAULT false,
    "s3_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "transcription" JSONB,
    "source_id" TEXT,
    "location_ids" TEXT[],
    "location_pcodes" TEXT[],
    "event_types" TEXT[],
    "need_sectors" TEXT[],
    "time_range_start" TIMESTAMP(3),
    "time_range_end" TIMESTAMP(3),
    "extracted_by_model" TEXT NOT NULL,
    "extracted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_figures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_figures_report_id_idx" ON "report_figures"("report_id");

-- CreateIndex
CREATE INDEX "report_figures_location_ids_idx" ON "report_figures" USING GIN ("location_ids");

-- CreateIndex
CREATE INDEX "report_figures_event_types_idx" ON "report_figures" USING GIN ("event_types");

-- CreateIndex
CREATE INDEX "report_figures_need_sectors_idx" ON "report_figures" USING GIN ("need_sectors");

-- CreateIndex
CREATE INDEX "report_figures_kind_idx" ON "report_figures"("kind");

-- CreateIndex
CREATE INDEX "report_figures_source_id_idx" ON "report_figures"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_figures_report_id_page_number_s3_key_key" ON "report_figures"("report_id", "page_number", "s3_key");

