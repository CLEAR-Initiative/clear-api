-- CreateTable
CREATE TABLE "signal_location_challenges" (
    "id" TEXT NOT NULL,
    "signal_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'consideration',
    "note" TEXT,
    "proposed_lng" DOUBLE PRECISION,
    "proposed_lat" DOUBLE PRECISION,
    "proposed_name" TEXT,

    CONSTRAINT "signal_location_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signal_location_challenges_signal_id_idx" ON "signal_location_challenges"("signal_id");

-- CreateIndex
CREATE INDEX "signal_location_challenges_status_created_at_idx" ON "signal_location_challenges"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "signal_location_challenges_signal_id_status_key" ON "signal_location_challenges"("signal_id", "status");

-- Point-pair invariant: proposed_lng and proposed_lat are both set or both null.
-- (Not expressible in the Prisma schema, so added here; the resolver enforces
-- the same rule plus lat/lng ranges.)
ALTER TABLE "signal_location_challenges"
    ADD CONSTRAINT "signal_location_challenges_point_pair" CHECK (
        ("proposed_lng" IS NULL AND "proposed_lat" IS NULL)
        OR ("proposed_lng" IS NOT NULL AND "proposed_lat" IS NOT NULL)
    );

-- AddForeignKey
ALTER TABLE "signal_location_challenges" ADD CONSTRAINT "signal_location_challenges_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
