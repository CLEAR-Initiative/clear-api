-- AlterTable
ALTER TABLE "disaster_types" ADD COLUMN     "id_type" TEXT NOT NULL DEFAULT 'glide_number',
ADD COLUMN     "level_1" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "level_2" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "disaster_types_level_1_idx" ON "disaster_types"("level_1");

-- CreateIndex
CREATE INDEX "disaster_types_level_2_idx" ON "disaster_types"("level_2");

-- CreateIndex
CREATE INDEX "disaster_types_glide_number_idx" ON "disaster_types"("glide_number");
