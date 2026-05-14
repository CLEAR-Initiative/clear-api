-- Adds createdAt + updatedAt timestamps to alerts and locations.
-- Both columns default to CURRENT_TIMESTAMP so existing rows backfill
-- cleanly. Prisma's auto-generated diff omits the default on updated_at,
-- which would fail on a non-empty table — we override it here.

-- AlterTable: alerts
ALTER TABLE "alerts"
ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: locations
ALTER TABLE "locations"
ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
