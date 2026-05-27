-- AlterTable
ALTER TABLE "crises" ADD COLUMN     "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scenarios" JSONB;