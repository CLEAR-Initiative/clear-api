-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "ancestor_ids" TEXT[];

-- CreateIndex
CREATE INDEX "locations_ancestor_ids_idx" ON "locations" USING GIN ("ancestor_ids" array_ops);
