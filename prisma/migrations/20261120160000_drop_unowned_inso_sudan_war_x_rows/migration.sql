-- Take inso and sudan-war-x back out of 20261120120000_ensure_pipeline_data_sources.
-- Restoring those two sources on prod is out of scope for clear #1520; their
-- owners decide when they go live. Only the rows that migration created are
-- removed: their id equals their name. A row created by hand or by the seed has
-- a cuid id, so the existing rows on dev are kept.
--
-- A row already in use is kept as well: signals block the delete (RESTRICT), and
-- report datapoints and API source grants would be changed silently (SET NULL,
-- CASCADE). Ship this in the same prod sync as 20261120120000 so the rows never
-- exist on prod in between.
DELETE FROM "data_sources" d
WHERE d."id" IN ('inso', 'sudan-war-x')
  AND d."name" = d."id"
  AND NOT EXISTS (SELECT 1 FROM "signals" s WHERE s."source_id" = d."id")
  AND NOT EXISTS (SELECT 1 FROM "report_datapoints" r WHERE r."source_id" = d."id")
  AND NOT EXISTS (SELECT 1 FROM "api_signal_source_grants" g WHERE g."data_source_id" = d."id");
