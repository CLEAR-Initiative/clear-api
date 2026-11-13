-- CreateTable
CREATE TABLE "metric_annotations" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "link" TEXT,
    "metric_keys" TEXT[],
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metric_annotations_at_idx" ON "metric_annotations"("at");
