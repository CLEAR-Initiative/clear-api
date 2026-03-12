/*
  Warnings:

  - You are about to drop the column `detection_id` on the `signal` table. All the data in the column will be lost.
  - You are about to drop the `_AlertEvents` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `alert` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `detection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `detection_location` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[source_id]` on the table `signal` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `event_type` to the `event` table without a default value. This is not possible if the table is not empty.
  - Added the required column `first_signal` to the `event` table without a default value. This is not possible if the table is not empty.
  - Added the required column `last_signal_created_at` to the `event` table without a default value. This is not possible if the table is not empty.
  - Added the required column `rank` to the `event` table without a default value. This is not possible if the table is not empty.
  - Added the required column `severity` to the `event` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `event` table without a default value. This is not possible if the table is not empty.
  - Added the required column `collected_at` to the `signal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `published_at` to the `signal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source_id` to the `signal` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('email', 'sms');

-- CreateEnum
CREATE TYPE "Frequency" AS ENUM ('immediately', 'daily', 'weekly', 'monthly');

-- DropForeignKey
ALTER TABLE "_AlertEvents" DROP CONSTRAINT "_AlertEvents_A_fkey";

-- DropForeignKey
ALTER TABLE "_AlertEvents" DROP CONSTRAINT "_AlertEvents_B_fkey";

-- DropForeignKey
ALTER TABLE "alert" DROP CONSTRAINT "alert_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "alert" DROP CONSTRAINT "alert_primary_event_id_fkey";

-- DropForeignKey
ALTER TABLE "alert_location" DROP CONSTRAINT "alert_location_alert_id_fkey";

-- DropForeignKey
ALTER TABLE "detection" DROP CONSTRAINT "detection_source_id_fkey";

-- DropForeignKey
ALTER TABLE "detection_location" DROP CONSTRAINT "detection_location_detection_id_fkey";

-- DropForeignKey
ALTER TABLE "detection_location" DROP CONSTRAINT "detection_location_location_id_fkey";

-- DropForeignKey
ALTER TABLE "signal" DROP CONSTRAINT "signal_detection_id_fkey";

-- DropForeignKey
ALTER TABLE "user_alert" DROP CONSTRAINT "user_alert_alert_id_fkey";

-- DropIndex
DROP INDEX "signal_detection_id_key";

-- AlterTable
ALTER TABLE "event" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "destination" TEXT,
ADD COLUMN     "event_type" TEXT NOT NULL,
ADD COLUMN     "first_signal" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "is_alert" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_signal_created_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "population_affected" BIGINT,
ADD COLUMN     "rank" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "severity" INTEGER NOT NULL,
ADD COLUMN     "status" "alert_status" NOT NULL DEFAULT 'draft',
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "location" ADD COLUMN     "userAlertSubscriptionId" TEXT;

-- AlterTable
ALTER TABLE "signal" DROP COLUMN "detection_id",
ADD COLUMN     "collected_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "destination" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "published_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "source_id" TEXT NOT NULL;

-- DropTable
DROP TABLE "_AlertEvents";

-- DropTable
DROP TABLE "alert";

-- DropTable
DROP TABLE "detection";

-- DropTable
DROP TABLE "detection_location";

-- CreateTable
CREATE TABLE "organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_user" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',

    CONSTRAINT "organisation_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "status" "detection_status" NOT NULL DEFAULT 'raw',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_data" JSONB,
    "data_source_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_location" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_alert_subscription" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "channel" "Channel" NOT NULL,
    "frequency" "Frequency" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_alert_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisation_user_user_id_organisation_id_key" ON "organisation_user"("user_id", "organisation_id");

-- CreateIndex
CREATE INDEX "source_status_detected_at_idx" ON "source"("status", "detected_at");

-- CreateIndex
CREATE INDEX "source_data_source_id_detected_at_idx" ON "source"("data_source_id", "detected_at");

-- CreateIndex
CREATE INDEX "source_location_location_id_idx" ON "source_location"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_location_source_id_location_id_key" ON "source_location"("source_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_source_id_key" ON "signal"("source_id");

-- AddForeignKey
ALTER TABLE "organisation_user" ADD CONSTRAINT "organisation_user_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_user" ADD CONSTRAINT "organisation_user_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_userAlertSubscriptionId_fkey" FOREIGN KEY ("userAlertSubscriptionId") REFERENCES "user_alert_subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source" ADD CONSTRAINT "source_data_source_id_fkey" FOREIGN KEY ("data_source_id") REFERENCES "data_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_origin_fkey" FOREIGN KEY ("origin") REFERENCES "location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_destination_fkey" FOREIGN KEY ("destination") REFERENCES "location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_location_fkey" FOREIGN KEY ("location") REFERENCES "location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_origin_fkey" FOREIGN KEY ("origin") REFERENCES "location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_destination_fkey" FOREIGN KEY ("destination") REFERENCES "location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_location_fkey" FOREIGN KEY ("location") REFERENCES "location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_location" ADD CONSTRAINT "alert_location_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_location" ADD CONSTRAINT "source_location_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_location" ADD CONSTRAINT "source_location_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alert" ADD CONSTRAINT "user_alert_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
