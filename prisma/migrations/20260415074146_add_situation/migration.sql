-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "population" BIGINT;

-- AlterTable
ALTER TABLE "user_comments" ADD COLUMN     "situation_id" TEXT;

-- AlterTable
ALTER TABLE "user_feedbacks" ADD COLUMN     "situation_id" TEXT;

-- CreateTable
CREATE TABLE "situations" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "severity" DOUBLE PRECISION NOT NULL,
    "location_id" TEXT,
    "needs" JSONB NOT NULL,
    "population_affected" BIGINT,
    "population_in_area" BIGINT,

    CONSTRAINT "situations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_to_situations" (
    "id" TEXT NOT NULL,
    "situation_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_to_situations_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "situations" ADD CONSTRAINT "situations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedbacks" ADD CONSTRAINT "user_feedbacks_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_to_situations" ADD CONSTRAINT "event_to_situations_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_to_situations" ADD CONSTRAINT "event_to_situations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
