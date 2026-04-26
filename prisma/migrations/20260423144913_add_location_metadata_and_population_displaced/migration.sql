-- AlterTable
ALTER TABLE "events" ADD COLUMN     "population_displaced" BIGINT;

-- CreateTable
CREATE TABLE "location_metadata" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "location_metadata_type_idx" ON "location_metadata"("type");

-- CreateIndex
CREATE UNIQUE INDEX "location_metadata_location_id_type_key" ON "location_metadata"("location_id", "type");

-- AddForeignKey
ALTER TABLE "location_metadata" ADD CONSTRAINT "location_metadata_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
