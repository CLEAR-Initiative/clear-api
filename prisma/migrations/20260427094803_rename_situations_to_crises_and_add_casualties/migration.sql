/*
  Warnings:

  - You are about to drop the column `is_situation` on the `event_escaladed_by_users` table. All the data in the column will be lost.
  - You are about to drop the column `situation_id` on the `user_comments` table. All the data in the column will be lost.
  - You are about to drop the column `situation_id` on the `user_feedbacks` table. All the data in the column will be lost.
  - You are about to drop the `event_to_situations` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `situations` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "event_to_situations" DROP CONSTRAINT "event_to_situations_event_id_fkey";

-- DropForeignKey
ALTER TABLE "event_to_situations" DROP CONSTRAINT "event_to_situations_situation_id_fkey";

-- DropForeignKey
ALTER TABLE "situations" DROP CONSTRAINT "situations_location_id_fkey";

-- DropForeignKey
ALTER TABLE "user_comments" DROP CONSTRAINT "user_comments_situation_id_fkey";

-- DropForeignKey
ALTER TABLE "user_feedbacks" DROP CONSTRAINT "user_feedbacks_situation_id_fkey";

-- AlterTable
ALTER TABLE "event_escaladed_by_users" DROP COLUMN "is_situation",
ADD COLUMN     "is_crisis" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "casualties" INTEGER;

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "casualties" INTEGER;

-- AlterTable
ALTER TABLE "user_comments" DROP COLUMN "situation_id",
ADD COLUMN     "crisis_id" TEXT;

-- AlterTable
ALTER TABLE "user_feedbacks" DROP COLUMN "situation_id",
ADD COLUMN     "crisis_id" TEXT;

-- DropTable
DROP TABLE "event_to_situations";

-- DropTable
DROP TABLE "situations";

-- CreateTable
CREATE TABLE "crises" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "severity" DOUBLE PRECISION NOT NULL,
    "location_id" TEXT,
    "needs" JSONB NOT NULL,
    "population_affected" BIGINT,
    "population_in_area" BIGINT,

    CONSTRAINT "crises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_to_crises" (
    "id" TEXT NOT NULL,
    "crisis_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_to_crises_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "crises" ADD CONSTRAINT "crises_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedbacks" ADD CONSTRAINT "user_feedbacks_crisis_id_fkey" FOREIGN KEY ("crisis_id") REFERENCES "crises"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_crisis_id_fkey" FOREIGN KEY ("crisis_id") REFERENCES "crises"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_to_crises" ADD CONSTRAINT "event_to_crises_crisis_id_fkey" FOREIGN KEY ("crisis_id") REFERENCES "crises"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_to_crises" ADD CONSTRAINT "event_to_crises_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
