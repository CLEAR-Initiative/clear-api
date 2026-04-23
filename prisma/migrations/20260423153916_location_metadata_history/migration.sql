-- DropIndex
DROP INDEX "location_metadata_location_id_type_key";

-- DropIndex
DROP INDEX "location_metadata_type_idx";

-- AlterTable
ALTER TABLE "location_metadata" ADD COLUMN     "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "valid_to" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "location_metadata_location_id_type_idx" ON "location_metadata"("location_id", "type");

-- CreateIndex
CREATE INDEX "location_metadata_location_id_type_valid_to_idx" ON "location_metadata"("location_id", "type", "valid_to");

-- CreateIndex
CREATE INDEX "location_metadata_type_valid_to_idx" ON "location_metadata"("type", "valid_to");
