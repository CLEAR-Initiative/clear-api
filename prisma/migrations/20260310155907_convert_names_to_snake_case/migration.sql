/*
  Warnings:

  - You are about to drop the column `accessToken` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `accessTokenExpiresAt` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `accountId` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `idToken` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `providerId` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `refreshToken` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `refreshTokenExpiresAt` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `account` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `session` table. All the data in the column will be lost.
  - You are about to drop the column `expiresAt` on the `session` table. All the data in the column will be lost.
  - You are about to drop the column `ipAddress` on the `session` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `session` table. All the data in the column will be lost.
  - You are about to drop the column `userAgent` on the `session` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `session` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `emailVerified` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `enableEmailNotification` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `enableInAppNotification` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `enableSMSNotification` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `phoneNumber` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `verification` table. All the data in the column will be lost.
  - You are about to drop the column `expiresAt` on the `verification` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `verification` table. All the data in the column will be lost.
  - You are about to drop the `Alert` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AlertLocation` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ApiKey` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DataSource` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Detection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DetectionLocation` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Event` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `FeatureFlag` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Location` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Notifications` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Signal` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserAlert` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `account_id` to the `account` table without a default value. This is not possible if the table is not empty.
  - Added the required column `provider_id` to the `account` table without a default value. This is not possible if the table is not empty.
  - Added the required column `user_id` to the `account` table without a default value. This is not possible if the table is not empty.
  - Added the required column `expires_at` to the `session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `user_id` to the `session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `expires_at` to the `verification` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "alert_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "detection_status" AS ENUM ('raw', 'processed', 'ignored');

-- CreateEnum
CREATE TYPE "point_type" AS ENUM ('CENTROID', 'GPS');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'READ');

-- DropForeignKey
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_primaryEventId_fkey";

-- DropForeignKey
ALTER TABLE "AlertLocation" DROP CONSTRAINT "AlertLocation_alertId_fkey";

-- DropForeignKey
ALTER TABLE "AlertLocation" DROP CONSTRAINT "AlertLocation_locationId_fkey";

-- DropForeignKey
ALTER TABLE "ApiKey" DROP CONSTRAINT "ApiKey_userId_fkey";

-- DropForeignKey
ALTER TABLE "Detection" DROP CONSTRAINT "Detection_sourceId_fkey";

-- DropForeignKey
ALTER TABLE "DetectionLocation" DROP CONSTRAINT "DetectionLocation_detectionId_fkey";

-- DropForeignKey
ALTER TABLE "DetectionLocation" DROP CONSTRAINT "DetectionLocation_locationId_fkey";

-- DropForeignKey
ALTER TABLE "Event" DROP CONSTRAINT "Event_primarySignalId_fkey";

-- DropForeignKey
ALTER TABLE "Location" DROP CONSTRAINT "Location_parentId_fkey";

-- DropForeignKey
ALTER TABLE "Notifications" DROP CONSTRAINT "Notifications_userId_fkey";

-- DropForeignKey
ALTER TABLE "Signal" DROP CONSTRAINT "Signal_detectionId_fkey";

-- DropForeignKey
ALTER TABLE "UserAlert" DROP CONSTRAINT "UserAlert_alertId_fkey";

-- DropForeignKey
ALTER TABLE "UserAlert" DROP CONSTRAINT "UserAlert_userId_fkey";

-- DropForeignKey
ALTER TABLE "_AlertEvents" DROP CONSTRAINT "_AlertEvents_A_fkey";

-- DropForeignKey
ALTER TABLE "_AlertEvents" DROP CONSTRAINT "_AlertEvents_B_fkey";

-- DropForeignKey
ALTER TABLE "_EventSignals" DROP CONSTRAINT "_EventSignals_A_fkey";

-- DropForeignKey
ALTER TABLE "_EventSignals" DROP CONSTRAINT "_EventSignals_B_fkey";

-- DropForeignKey
ALTER TABLE "account" DROP CONSTRAINT "account_userId_fkey";

-- DropForeignKey
ALTER TABLE "session" DROP CONSTRAINT "session_userId_fkey";

-- AlterTable
ALTER TABLE "account" DROP COLUMN "accessToken",
DROP COLUMN "accessTokenExpiresAt",
DROP COLUMN "accountId",
DROP COLUMN "createdAt",
DROP COLUMN "idToken",
DROP COLUMN "providerId",
DROP COLUMN "refreshToken",
DROP COLUMN "refreshTokenExpiresAt",
DROP COLUMN "updatedAt",
DROP COLUMN "userId",
ADD COLUMN     "access_token" TEXT,
ADD COLUMN     "access_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "account_id" TEXT NOT NULL,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "id_token" TEXT,
ADD COLUMN     "provider_id" TEXT NOT NULL,
ADD COLUMN     "refresh_token" TEXT,
ADD COLUMN     "refresh_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "user_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "session" DROP COLUMN "createdAt",
DROP COLUMN "expiresAt",
DROP COLUMN "ipAddress",
DROP COLUMN "updatedAt",
DROP COLUMN "userAgent",
DROP COLUMN "userId",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "expires_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "ip_address" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "user_agent" TEXT,
ADD COLUMN     "user_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "user" DROP COLUMN "createdAt",
DROP COLUMN "emailVerified",
DROP COLUMN "enableEmailNotification",
DROP COLUMN "enableInAppNotification",
DROP COLUMN "enableSMSNotification",
DROP COLUMN "isActive",
DROP COLUMN "phoneNumber",
DROP COLUMN "updatedAt",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "email_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enable_email_notification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enable_in_app_notification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enable_sms_notification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "phone_number" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "verification" DROP COLUMN "createdAt",
DROP COLUMN "expiresAt",
DROP COLUMN "updatedAt",
ADD COLUMN     "created_at" TIMESTAMP(3),
ADD COLUMN     "expires_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMP(3);

-- DropTable
DROP TABLE "Alert";

-- DropTable
DROP TABLE "AlertLocation";

-- DropTable
DROP TABLE "ApiKey";

-- DropTable
DROP TABLE "DataSource";

-- DropTable
DROP TABLE "Detection";

-- DropTable
DROP TABLE "DetectionLocation";

-- DropTable
DROP TABLE "Event";

-- DropTable
DROP TABLE "FeatureFlag";

-- DropTable
DROP TABLE "Location";

-- DropTable
DROP TABLE "Notifications";

-- DropTable
DROP TABLE "Signal";

-- DropTable
DROP TABLE "UserAlert";

-- DropEnum
DROP TYPE "AlertStatus";

-- DropEnum
DROP TYPE "DetectionStatus";

-- DropEnum
DROP TYPE "NotificationStatus";

-- DropEnum
DROP TYPE "PointType";

-- CreateTable
CREATE TABLE "location" (
    "id" TEXT NOT NULL,
    "geo_id" TEXT NOT NULL,
    "point" geography(Point,4326),
    "boundary" geometry(MultiPolygon,4326),
    "point_type" "point_type",
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "parent_id" TEXT,

    CONSTRAINT "location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_source" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "base_url" TEXT,
    "info_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detection" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "status" "detection_status" NOT NULL DEFAULT 'raw',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_data" JSONB,
    "source_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal" (
    "id" TEXT NOT NULL,
    "detection_id" TEXT NOT NULL,

    CONSTRAINT "signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event" (
    "id" TEXT NOT NULL,
    "primary_signal_id" TEXT,

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" INTEGER NOT NULL,
    "status" "alert_status" NOT NULL DEFAULT 'draft',
    "created_by_id" TEXT,
    "primary_event_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_location" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detection_location" (
    "id" TEXT NOT NULL,
    "detection_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detection_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_alert" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "rating" INTEGER,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "notification_type" TEXT NOT NULL,
    "action_url" TEXT,
    "action_text" TEXT,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "email_notification_status" "notification_status",
    "sms_notification_status" "notification_status",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_geo_id_key" ON "location"("geo_id");

-- CreateIndex
CREATE INDEX "location_level_idx" ON "location"("level");

-- CreateIndex
CREATE INDEX "location_parent_id_idx" ON "location"("parent_id");

-- CreateIndex
CREATE INDEX "data_source_type_idx" ON "data_source"("type");

-- CreateIndex
CREATE INDEX "data_source_is_active_idx" ON "data_source"("is_active");

-- CreateIndex
CREATE INDEX "detection_status_detected_at_idx" ON "detection"("status", "detected_at");

-- CreateIndex
CREATE INDEX "detection_source_id_detected_at_idx" ON "detection"("source_id", "detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "signal_detection_id_key" ON "signal"("detection_id");

-- CreateIndex
CREATE INDEX "alert_status_created_at_idx" ON "alert"("status", "created_at");

-- CreateIndex
CREATE INDEX "alert_severity_idx" ON "alert"("severity");

-- CreateIndex
CREATE INDEX "alert_created_by_id_idx" ON "alert"("created_by_id");

-- CreateIndex
CREATE INDEX "alert_location_location_id_idx" ON "alert_location"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_location_alert_id_location_id_key" ON "alert_location"("alert_id", "location_id");

-- CreateIndex
CREATE INDEX "detection_location_location_id_idx" ON "detection_location"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "detection_location_detection_id_location_id_key" ON "detection_location"("detection_id", "location_id");

-- CreateIndex
CREATE INDEX "user_alert_alert_id_idx" ON "user_alert"("alert_id");

-- CreateIndex
CREATE INDEX "user_alert_user_id_read_at_idx" ON "user_alert"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_alert_user_id_alert_id_key" ON "user_alert"("user_id", "alert_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_key_hash_key" ON "api_key"("key_hash");

-- CreateIndex
CREATE INDEX "api_key_key_hash_idx" ON "api_key"("key_hash");

-- CreateIndex
CREATE INDEX "api_key_user_id_idx" ON "api_key"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_key_key" ON "feature_flag"("key");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection" ADD CONSTRAINT "detection_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_detection_id_fkey" FOREIGN KEY ("detection_id") REFERENCES "detection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_primary_signal_id_fkey" FOREIGN KEY ("primary_signal_id") REFERENCES "signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_primary_event_id_fkey" FOREIGN KEY ("primary_event_id") REFERENCES "event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_location" ADD CONSTRAINT "alert_location_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_location" ADD CONSTRAINT "alert_location_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_location" ADD CONSTRAINT "detection_location_detection_id_fkey" FOREIGN KEY ("detection_id") REFERENCES "detection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_location" ADD CONSTRAINT "detection_location_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alert" ADD CONSTRAINT "user_alert_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alert" ADD CONSTRAINT "user_alert_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EventSignals" ADD CONSTRAINT "_EventSignals_A_fkey" FOREIGN KEY ("A") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EventSignals" ADD CONSTRAINT "_EventSignals_B_fkey" FOREIGN KEY ("B") REFERENCES "signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AlertEvents" ADD CONSTRAINT "_AlertEvents_A_fkey" FOREIGN KEY ("A") REFERENCES "alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AlertEvents" ADD CONSTRAINT "_AlertEvents_B_fkey" FOREIGN KEY ("B") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
