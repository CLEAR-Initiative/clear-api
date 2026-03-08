/*
  Warnings:

  - You are about to drop the column `sourceId` on the `Alert` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_sourceId_fkey";

-- DropIndex
DROP INDEX "Alert_sourceId_idx";

-- AlterTable
ALTER TABLE "Alert" DROP COLUMN "sourceId";
