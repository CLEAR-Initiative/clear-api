-- AlterTable
ALTER TABLE "events" ADD COLUMN     "isDummy" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "isDummy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "media" TEXT[];
