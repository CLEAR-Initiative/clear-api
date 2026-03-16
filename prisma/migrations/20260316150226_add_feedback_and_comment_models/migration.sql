/*
  Warnings:

  - You are about to drop the column `enable_email_notification` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `enable_in_app_notification` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `enable_sms_notification` on the `user` table. All the data in the column will be lost.
  - You are about to drop the `_EventSignals` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `alert_location` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `api_key` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `data_source` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `event` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `feature_flag` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `location` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `organisation` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `organisation_user` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `signal` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `source` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `source_location` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `user_alert` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `user_alert_subscription` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "_EventSignals" DROP CONSTRAINT "_EventSignals_A_fkey";

-- DropForeignKey
ALTER TABLE "_EventSignals" DROP CONSTRAINT "_EventSignals_B_fkey";

-- DropForeignKey
ALTER TABLE "alert_location" DROP CONSTRAINT "alert_location_alert_id_fkey";

-- DropForeignKey
ALTER TABLE "alert_location" DROP CONSTRAINT "alert_location_location_id_fkey";

-- DropForeignKey
ALTER TABLE "api_key" DROP CONSTRAINT "api_key_user_id_fkey";

-- DropForeignKey
ALTER TABLE "event" DROP CONSTRAINT "event_destination_fkey";

-- DropForeignKey
ALTER TABLE "event" DROP CONSTRAINT "event_location_fkey";

-- DropForeignKey
ALTER TABLE "event" DROP CONSTRAINT "event_origin_fkey";

-- DropForeignKey
ALTER TABLE "event" DROP CONSTRAINT "event_primary_signal_id_fkey";

-- DropForeignKey
ALTER TABLE "location" DROP CONSTRAINT "location_parent_id_fkey";

-- DropForeignKey
ALTER TABLE "organisation_user" DROP CONSTRAINT "organisation_user_organisation_id_fkey";

-- DropForeignKey
ALTER TABLE "organisation_user" DROP CONSTRAINT "organisation_user_user_id_fkey";

-- DropForeignKey
ALTER TABLE "signal" DROP CONSTRAINT "signal_destination_fkey";

-- DropForeignKey
ALTER TABLE "signal" DROP CONSTRAINT "signal_location_fkey";

-- DropForeignKey
ALTER TABLE "signal" DROP CONSTRAINT "signal_origin_fkey";

-- DropForeignKey
ALTER TABLE "signal" DROP CONSTRAINT "signal_source_id_fkey";

-- DropForeignKey
ALTER TABLE "source" DROP CONSTRAINT "source_data_source_id_fkey";

-- DropForeignKey
ALTER TABLE "source_location" DROP CONSTRAINT "source_location_location_id_fkey";

-- DropForeignKey
ALTER TABLE "source_location" DROP CONSTRAINT "source_location_source_id_fkey";

-- DropForeignKey
ALTER TABLE "user_alert" DROP CONSTRAINT "user_alert_alert_id_fkey";

-- DropForeignKey
ALTER TABLE "user_alert" DROP CONSTRAINT "user_alert_user_id_fkey";

-- DropForeignKey
ALTER TABLE "user_alert_subscription" DROP CONSTRAINT "user_alert_subscription_locationId_fkey";

-- AlterTable
ALTER TABLE "user" DROP COLUMN "enable_email_notification",
DROP COLUMN "enable_in_app_notification",
DROP COLUMN "enable_sms_notification",
ADD COLUMN     "email_notification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "in_app_notification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sms_notification" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "_EventSignals";

-- DropTable
DROP TABLE "alert_location";

-- DropTable
DROP TABLE "api_key";

-- DropTable
DROP TABLE "data_source";

-- DropTable
DROP TABLE "event";

-- DropTable
DROP TABLE "feature_flag";

-- DropTable
DROP TABLE "location";

-- DropTable
DROP TABLE "organisation";

-- DropTable
DROP TABLE "organisation_user";

-- DropTable
DROP TABLE "signal";

-- DropTable
DROP TABLE "source";

-- DropTable
DROP TABLE "source_location";

-- DropTable
DROP TABLE "user_alert";

-- DropTable
DROP TABLE "user_alert_subscription";

-- CreateTable
CREATE TABLE "organisations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_users" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',

    CONSTRAINT "organisation_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "geonames_id" INTEGER,
    "osm_id" BIGINT,
    "p_code" VARCHAR(50),
    "geometry" geometry(Geometry, 4326) NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "parent_id" TEXT,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "base_url" TEXT,
    "info_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "raw_data" JSONB NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL,
    "url" TEXT,
    "title" TEXT,
    "description" TEXT,
    "origin_id" TEXT,
    "destination_id" TEXT,
    "location_id" TEXT,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "description_signals" JSONB,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "first_signal_created_at" TIMESTAMP(3) NOT NULL,
    "last_signal_created_at" TIMESTAMP(3) NOT NULL,
    "origin_id" TEXT,
    "destination_id" TEXT,
    "location_id" TEXT,
    "types" TEXT[],
    "population_affected" BIGINT,
    "rank" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" "alert_status" NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_alerts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "viewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_escaladed_by_users" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "is_situation" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_escaladed_by_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_feedbacks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_id" TEXT,
    "signal_id" TEXT,
    "rating" INTEGER NOT NULL,
    "feedback" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_comments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_id" TEXT,
    "signal_id" TEXT,
    "comment" TEXT NOT NULL,
    "is_comment_reply" BOOLEAN NOT NULL,
    "replied_to_comment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_tags" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,

    CONSTRAINT "comment_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_alert_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "channel" "Channel" NOT NULL,
    "frequency" "Frequency" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_alert_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_to_events" (
    "id" TEXT NOT NULL,
    "signal_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signal_to_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
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

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisation_users_user_id_organisation_id_key" ON "organisation_users"("user_id", "organisation_id");

-- CreateIndex
CREATE INDEX "locations_level_idx" ON "locations"("level");

-- CreateIndex
CREATE INDEX "locations_parent_id_idx" ON "locations"("parent_id");

-- CreateIndex
CREATE INDEX "data_sources_type_idx" ON "data_sources"("type");

-- CreateIndex
CREATE INDEX "data_sources_is_active_idx" ON "data_sources"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "signals_source_id_key" ON "signals"("source_id");

-- CreateIndex
CREATE INDEX "user_alerts_alert_id_idx" ON "user_alerts"("alert_id");

-- CreateIndex
CREATE INDEX "user_alerts_user_id_viewed_at_idx" ON "user_alerts"("user_id", "viewed_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_alerts_user_id_alert_id_key" ON "user_alerts"("user_id", "alert_id");

-- CreateIndex
CREATE INDEX "event_escaladed_by_users_alert_id_idx" ON "event_escaladed_by_users"("alert_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_escaladed_by_users_user_id_alert_id_key" ON "event_escaladed_by_users"("user_id", "alert_id");

-- CreateIndex
CREATE INDEX "user_feedbacks_user_id_idx" ON "user_feedbacks"("user_id");

-- CreateIndex
CREATE INDEX "user_comments_user_id_idx" ON "user_comments"("user_id");

-- CreateIndex
CREATE INDEX "user_comments_event_id_idx" ON "user_comments"("event_id");

-- CreateIndex
CREATE INDEX "user_comments_signal_id_idx" ON "user_comments"("signal_id");

-- CreateIndex
CREATE INDEX "comment_tags_comment_id_idx" ON "comment_tags"("comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_key_hash_idx" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- AddForeignKey
ALTER TABLE "organisation_users" ADD CONSTRAINT "organisation_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_users" ADD CONSTRAINT "organisation_users_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_origin_id_fkey" FOREIGN KEY ("origin_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_origin_id_fkey" FOREIGN KEY ("origin_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_escaladed_by_users" ADD CONSTRAINT "event_escaladed_by_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_escaladed_by_users" ADD CONSTRAINT "event_escaladed_by_users_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedbacks" ADD CONSTRAINT "user_feedbacks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedbacks" ADD CONSTRAINT "user_feedbacks_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedbacks" ADD CONSTRAINT "user_feedbacks_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_tags" ADD CONSTRAINT "comment_tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_tags" ADD CONSTRAINT "comment_tags_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "user_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alert_subscriptions" ADD CONSTRAINT "user_alert_subscriptions_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_to_events" ADD CONSTRAINT "signal_to_events_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_to_events" ADD CONSTRAINT "signal_to_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
