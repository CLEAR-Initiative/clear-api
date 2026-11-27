-- Other sites of a Signal (ADR-0025, Exponential #1690). A Signal keeps one
-- primary location in "signals"."location_id"; this table holds the other
-- places that its text names. Additive: no existing column changes.

-- CreateEnum
CREATE TYPE "signal_site_kind" AS ENUM ('NAMED_SITE');

-- CreateTable
CREATE TABLE "signal_sites" (
    "signal_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "kind" "signal_site_kind" NOT NULL DEFAULT 'NAMED_SITE',
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_sites_pkey" PRIMARY KEY ("signal_id","location_id")
);

-- CreateIndex
CREATE INDEX "signal_sites_location_id_idx" ON "signal_sites"("location_id");

-- AddForeignKey
ALTER TABLE "signal_sites" ADD CONSTRAINT "signal_sites_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_sites" ADD CONSTRAINT "signal_sites_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
