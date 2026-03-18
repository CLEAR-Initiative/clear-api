/*
  Warnings:

  - The primary key for the `comment_tags` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `comment_tags` table. All the data in the column will be lost.
  - You are about to drop the column `base_url` on the `data_sources` table. All the data in the column will be lost.
  - You are about to drop the column `info_url` on the `data_sources` table. All the data in the column will be lost.
  - You are about to drop the column `alert_id` on the `event_escaladed_by_users` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `event_escaladed_by_users` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `event_escaladed_by_users` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `user_alerts` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `user_alerts` table. All the data in the column will be lost.
  - You are about to drop the column `comment` on the `user_comments` table. All the data in the column will be lost.
  - You are about to drop the column `feedback` on the `user_feedbacks` table. All the data in the column will be lost.
  - You are about to drop the `organisation_users` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[user_id,comment_id]` on the table `comment_tags` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[user_id,event_id]` on the table `event_escaladed_by_users` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `event_id` to the `event_escaladed_by_users` table without a default value. This is not possible if the table is not empty.
  - Added the required column `valid_to` to the `event_escaladed_by_users` table without a default value. This is not possible if the table is not empty.
  - Added the required column `text` to the `user_comments` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "event_escaladed_by_users" DROP CONSTRAINT "event_escaladed_by_users_alert_id_fkey";

-- DropForeignKey
ALTER TABLE "organisation_users" DROP CONSTRAINT "organisation_users_organisation_id_fkey";

-- DropForeignKey
ALTER TABLE "organisation_users" DROP CONSTRAINT "organisation_users_user_id_fkey";

-- DropIndex
DROP INDEX "event_escaladed_by_users_alert_id_idx";

-- DropIndex
DROP INDEX "event_escaladed_by_users_user_id_alert_id_key";

-- AlterTable
ALTER TABLE "comment_tags" DROP CONSTRAINT "comment_tags_pkey",
DROP COLUMN "id";

-- AlterTable
ALTER TABLE "data_sources" DROP COLUMN "base_url",
DROP COLUMN "info_url",
ADD COLUMN     "url_base" TEXT,
ADD COLUMN     "url_info" TEXT;

-- AlterTable
ALTER TABLE "event_escaladed_by_users" DROP COLUMN "alert_id",
DROP COLUMN "created_at",
DROP COLUMN "updated_at",
ADD COLUMN     "event_id" TEXT NOT NULL,
ADD COLUMN     "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "valid_to" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "events" ALTER COLUMN "valid_from" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "signals" ALTER COLUMN "collected_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "user_alerts" DROP COLUMN "created_at",
DROP COLUMN "updated_at";

-- AlterTable
ALTER TABLE "user_comments" DROP COLUMN "comment",
ADD COLUMN     "text" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "user_feedbacks" DROP COLUMN "feedback",
ADD COLUMN     "text" TEXT;

-- DropTable
DROP TABLE "organisation_users";

-- CreateTable
CREATE TABLE "user_to_organisation" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',

    CONSTRAINT "user_to_organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disaster_types" (
    "id" TEXT NOT NULL,
    "disaster_type" TEXT NOT NULL,
    "disaster_class" TEXT NOT NULL,
    "glide_number" TEXT NOT NULL,

    CONSTRAINT "disaster_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_to_organisation_user_id_organisation_id_key" ON "user_to_organisation"("user_id", "organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "comment_tags_user_id_comment_id_key" ON "comment_tags"("user_id", "comment_id");

-- CreateIndex
CREATE INDEX "event_escaladed_by_users_event_id_idx" ON "event_escaladed_by_users"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_escaladed_by_users_user_id_event_id_key" ON "event_escaladed_by_users"("user_id", "event_id");

-- AddForeignKey
ALTER TABLE "user_to_organisation" ADD CONSTRAINT "user_to_organisation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_to_organisation" ADD CONSTRAINT "user_to_organisation_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_escaladed_by_users" ADD CONSTRAINT "event_escaladed_by_users_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
