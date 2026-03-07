CREATE EXTENSION IF NOT EXISTS postgis;
-- CreateEnum
CREATE TYPE "PointType" AS ENUM ('CENTROID', 'GPS');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'READ');

-- DropForeignKey
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_primaryDetectionId_fkey";

-- DropForeignKey
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_sourceId_fkey";

-- DropForeignKey
ALTER TABLE "AlertLocation" DROP CONSTRAINT "AlertLocation_alertId_fkey";

-- DropForeignKey
ALTER TABLE "AlertLocation" DROP CONSTRAINT "AlertLocation_locationId_fkey";

-- DropForeignKey
ALTER TABLE "Detection" DROP CONSTRAINT "Detection_alertId_fkey";

-- DropForeignKey
ALTER TABLE "Detection" DROP CONSTRAINT "Detection_sourceId_fkey";

-- DropForeignKey
ALTER TABLE "DetectionLocation" DROP CONSTRAINT "DetectionLocation_detectionId_fkey";

-- DropForeignKey
ALTER TABLE "DetectionLocation" DROP CONSTRAINT "DetectionLocation_locationId_fkey";

-- DropForeignKey
ALTER TABLE "Location" DROP CONSTRAINT "Location_parentId_fkey";

-- DropForeignKey
ALTER TABLE "UserAlert" DROP CONSTRAINT "UserAlert_alertId_fkey";

-- DropIndex
DROP INDEX "Detection_alertId_idx";

-- AlterTable
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_pkey",
DROP COLUMN "primaryDetectionId",
ADD COLUMN     "primaryEventId" TEXT,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "sourceId" SET DATA TYPE TEXT,
ADD CONSTRAINT "Alert_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Alert_id_seq";

-- AlterTable
ALTER TABLE "AlertLocation" DROP CONSTRAINT "AlertLocation_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "alertId" SET DATA TYPE TEXT,
ALTER COLUMN "locationId" SET DATA TYPE TEXT,
ADD CONSTRAINT "AlertLocation_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "AlertLocation_id_seq";

-- AlterTable
ALTER TABLE "ApiKey" DROP CONSTRAINT "ApiKey_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "ApiKey_id_seq";

-- AlterTable
ALTER TABLE "DataSource" DROP CONSTRAINT "DataSource_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "DataSource_id_seq";

-- AlterTable
ALTER TABLE "Detection" DROP CONSTRAINT "Detection_pkey",
DROP COLUMN "alertId",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "sourceId" SET DATA TYPE TEXT,
ADD CONSTRAINT "Detection_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Detection_id_seq";

-- AlterTable
ALTER TABLE "DetectionLocation" DROP CONSTRAINT "DetectionLocation_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "detectionId" SET DATA TYPE TEXT,
ALTER COLUMN "locationId" SET DATA TYPE TEXT,
ADD CONSTRAINT "DetectionLocation_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "DetectionLocation_id_seq";

-- AlterTable
ALTER TABLE "FeatureFlag" DROP CONSTRAINT "FeatureFlag_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "FeatureFlag_id_seq";

-- AlterTable
ALTER TABLE "Location" DROP CONSTRAINT "Location_pkey",
ADD COLUMN     "boundary" geometry(MultiPolygon,4326),
ADD COLUMN     "point" geography(Point,4326),
ADD COLUMN     "pointType" "PointType",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "parentId" SET DATA TYPE TEXT,
ADD CONSTRAINT "Location_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Location_id_seq";

-- AlterTable
ALTER TABLE "UserAlert" DROP CONSTRAINT "UserAlert_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "alertId" SET DATA TYPE TEXT,
ADD CONSTRAINT "UserAlert_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "UserAlert_id_seq";

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "enableEmailNotification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enableInAppNotification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enableSMSNotification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phoneNumber" TEXT;

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "detectionId" TEXT NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "primarySignalId" TEXT,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "notificationType" TEXT NOT NULL,
    "actionUrl" TEXT,
    "actionText" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "emailNotificationStatus" "NotificationStatus",
    "smsNotificationStatus" "NotificationStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_EventSignals" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_EventSignals_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_AlertEvents" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_AlertEvents_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Signal_detectionId_key" ON "Signal"("detectionId");

-- CreateIndex
CREATE INDEX "_EventSignals_B_index" ON "_EventSignals"("B");

-- CreateIndex
CREATE INDEX "_AlertEvents_B_index" ON "_AlertEvents"("B");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Detection" ADD CONSTRAINT "Detection_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_detectionId_fkey" FOREIGN KEY ("detectionId") REFERENCES "Detection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_primarySignalId_fkey" FOREIGN KEY ("primarySignalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_primaryEventId_fkey" FOREIGN KEY ("primaryEventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertLocation" ADD CONSTRAINT "AlertLocation_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertLocation" ADD CONSTRAINT "AlertLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetectionLocation" ADD CONSTRAINT "DetectionLocation_detectionId_fkey" FOREIGN KEY ("detectionId") REFERENCES "Detection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetectionLocation" ADD CONSTRAINT "DetectionLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAlert" ADD CONSTRAINT "UserAlert_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EventSignals" ADD CONSTRAINT "_EventSignals_A_fkey" FOREIGN KEY ("A") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EventSignals" ADD CONSTRAINT "_EventSignals_B_fkey" FOREIGN KEY ("B") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AlertEvents" ADD CONSTRAINT "_AlertEvents_A_fkey" FOREIGN KEY ("A") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AlertEvents" ADD CONSTRAINT "_AlertEvents_B_fkey" FOREIGN KEY ("B") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
