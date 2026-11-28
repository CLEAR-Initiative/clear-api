-- CreateEnum
CREATE TYPE "alert_email_delivery" AS ENUM ('individual', 'digest');

-- CreateTable
CREATE TABLE "alert_email_queue" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivery" "alert_email_delivery",

    CONSTRAINT "alert_email_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_email_queue_sent_at_queued_at_idx" ON "alert_email_queue"("sent_at", "queued_at");

-- CreateIndex
CREATE INDEX "alert_email_queue_claimed_at_idx" ON "alert_email_queue"("claimed_at");

-- CreateIndex
CREATE INDEX "alert_email_queue_user_id_queued_at_idx" ON "alert_email_queue"("user_id", "queued_at");

-- CreateIndex
CREATE UNIQUE INDEX "alert_email_queue_user_id_alert_id_key" ON "alert_email_queue"("user_id", "alert_id");

-- AddForeignKey
ALTER TABLE "alert_email_queue" ADD CONSTRAINT "alert_email_queue_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_email_queue" ADD CONSTRAINT "alert_email_queue_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
