/*
  Warnings:

  - A unique constraint covering the columns `[source_id,external_id]` on the table `signals` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "external_id" TEXT;

-- CreateIndex
CREATE INDEX "signals_source_id_idx" ON "signals"("source_id");

-- CreateIndex
CREATE INDEX "signals_published_at_idx" ON "signals"("published_at");

-- CreateIndex
CREATE UNIQUE INDEX "signals_source_id_external_id_key" ON "signals"("source_id", "external_id");
