-- CreateEnum
CREATE TYPE "BriefCadence" AS ENUM ('daily', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "BriefStatus" AS ENUM ('draft', 'sent');

-- CreateEnum
CREATE TYPE "BriefItemKind" AS ENUM ('alert', 'event', 'signal');

-- CreateTable
CREATE TABLE "briefs" (
    "id" TEXT NOT NULL,
    "cadence" "BriefCadence" NOT NULL,
    "status" "BriefStatus" NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "location_name" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "closing_notes" TEXT NOT NULL DEFAULT '',
    "counts_snapshot" JSONB,
    "created_by_id" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "sent_by_id" TEXT,
    "sent_to_list_id" TEXT,
    "sent_count" INTEGER,
    "failed_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief_items" (
    "id" TEXT NOT NULL,
    "brief_id" TEXT NOT NULL,
    "kind" "BriefItemKind" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brief_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "briefs_created_at_idx" ON "briefs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "brief_items_brief_id_kind_entity_id_key" ON "brief_items"("brief_id", "kind", "entity_id");

-- AddForeignKey
ALTER TABLE "brief_items" ADD CONSTRAINT "brief_items_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
