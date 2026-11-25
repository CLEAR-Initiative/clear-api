-- darfur24, looked up by name by clear-pipeline (DARFUR24_SOURCE_NAME). Missed
-- by 20261120120000_ensure_pipeline_data_sources because it had no seed row.
-- Values copy the dev row (type news, no info URL). Idempotent: an existing
-- row with this name is left untouched.
INSERT INTO "data_sources" ("id", "name", "type", "is_active", "url_base", "updated_at")
SELECT 'darfur24', 'darfur24', 'news', true, 'https://darfur24.com', now()
WHERE NOT EXISTS (SELECT 1 FROM "data_sources" WHERE "name" = 'darfur24');
