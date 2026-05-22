-- Adds `signals.geoparsed_data` to hold the clear-pipeline geoparser's
-- output. Additive enrichment, written at ingest, read for comparison
-- against the source's coordinates. Not used for routing in this phase.
--
-- Shape documented on the Prisma model — typically:
--   {
--     "candidate": "Nyala Airport",
--     "kind":      "landmark" | "admin",
--     "field":     "title" | "body",
--     "lat":       12.0537,
--     "lng":       24.9543,
--     ...
--   }

-- AlterTable
ALTER TABLE "signals" ADD COLUMN "geoparsed_data" JSONB;
