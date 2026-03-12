/*
  Warnings:

  - You are about to drop the column `boundary` on the `location` table. All the data in the column will be lost.
  - You are about to drop the column `geo_id` on the `location` table. All the data in the column will be lost.
  - You are about to drop the column `point` on the `location` table. All the data in the column will be lost.
  - You are about to drop the column `point_type` on the `location` table. All the data in the column will be lost.
  - You are about to drop the column `userAlertSubscriptionId` on the `location` table. All the data in the column will be lost.
  - Added the required column `geometry` to the `location` table without a default value. This is not possible if the table is not empty.
  - Added the required column `locationId` to the `user_alert_subscription` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "location" DROP CONSTRAINT "location_userAlertSubscriptionId_fkey";

-- DropIndex
DROP INDEX "location_geo_id_key";

-- AlterTable
ALTER TABLE "location" DROP COLUMN "boundary",
DROP COLUMN "geo_id",
DROP COLUMN "point",
DROP COLUMN "point_type",
DROP COLUMN "userAlertSubscriptionId",
ADD COLUMN     "geometry" geometry(Geometry, 4326) NOT NULL,
ADD COLUMN     "geonames_id" INTEGER,
ADD COLUMN     "osm_id" BIGINT,
ADD COLUMN     "p_code" VARCHAR(50);

-- AlterTable
ALTER TABLE "user_alert_subscription" ADD COLUMN     "locationId" TEXT NOT NULL;

-- DropEnum
DROP TYPE "point_type";

-- CreateIndex
CREATE INDEX "user_alert_subscription_locationId_alert_type_idx" ON "user_alert_subscription"("locationId", "alert_type");

-- CreateIndex
CREATE INDEX "user_alert_subscription_locationId_idx" ON "user_alert_subscription"("locationId");

-- AddForeignKey
ALTER TABLE "user_alert_subscription" ADD CONSTRAINT "user_alert_subscription_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
