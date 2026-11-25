-- The data_sources rows clear-api's own createManualSignal requires.
--
-- That mutation accepts exactly three source names (TRUSTED_SOURCE_NAMES in
-- src/resolvers/signal.resolver.ts) and rejects any other, so each of the three
-- needs a row for an analyst to file a signal from it. Of the three, only
-- `field_officer` was created by anything — prisma/seed.ts, which runs on local
-- databases alone. `partner` exists on prod because somebody inserted it by
-- hand; `government` was never created anywhere by code.
--
-- The same shape of gap as the idmc / iom_dtm_flash_alerts incidents (clear
-- #1053, #1520), one repo over: a row the code looks up by name, left to
-- whoever remembered. clear #1523's deploy gate covers the names clear-pipeline
-- resolves and deliberately not these, because these are clear-api's to own.
-- This is clear-api owning them (clear #1568).
--
-- Idempotent, in the shape of 20261120120000_ensure_pipeline_data_sources: a row
-- whose name already exists is left untouched, whatever its id, active flag or
-- reliability grade. Field values copy prisma/seed.ts. The id is the name, as
-- for web_enrichment (20261007190000_add_case_proposals), since cuid() is
-- Prisma-side only.
--
-- Adding a name to TRUSTED_SOURCE_NAMES means adding it here too.
-- tests/db/trusted-manual-data-sources.db.test.ts fails until you do.
INSERT INTO "data_sources" ("id", "name", "type", "is_active", "updated_at")
SELECT v."name", v."name", 'manual', true, now()
FROM (VALUES ('field_officer'), ('partner'), ('government')) AS v("name")
WHERE NOT EXISTS (SELECT 1 FROM "data_sources" d WHERE d."name" = v."name");
