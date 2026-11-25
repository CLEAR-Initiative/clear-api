-- Data sources that clear-pipeline (and the X ingest route) look up by name.
-- A missing row fails the source's job on every run ("Data source '<name>' not
-- found in CLEAR API"): idmc on prod since 2026-10-20, iom_dtm_flash_alerts
-- since 2026-11-13 (clear tickets #1053, #1520). The seed only runs on local
-- databases, so shared environments depended on someone inserting each row by
-- hand. This migration creates any row that is missing, on every environment.
--
-- Idempotent: a row whose name already exists (created by hand or by the seed)
-- is left untouched, whatever its id, URLs, active flag or reliability grade.
-- Field values copy prisma/seed.ts. The id is the name, as for web_enrichment
-- (20261007190000_add_case_proposals), since cuid() is Prisma-side only.
--
-- A new automated source adds its row in a new migration like this one, not
-- only in the seed.
INSERT INTO "data_sources" ("id", "name", "type", "is_active", "url_base", "url_info", "updated_at")
SELECT v."name", v."name", v."type", true, v."url_base", v."url_info", now()
FROM (VALUES
  ('dataminr',             'api',     'https://api.dataminr.com/firstalert/',      'https://www.dataminr.com/'),
  ('acled',                'api',     'https://acleddata.com/api/',                'https://acleddata.com/'),
  ('gdacs',                'api',     'https://www.gdacs.org/gdacsapi/api/',       'https://gdacs.org/'),
  ('dtm',                  'api',     'https://dtmapi.iom.int/api/',               'https://dtm.iom.int/'),
  ('iom_dtm_flash_alerts', 'api',     'https://dtm.iom.int/flash-reports-export',  'https://dtm.iom.int/'),
  ('idmc',                 'api',     'https://helix-tools-api.idmcdb.org/',       'https://www.internal-displacement.org/'),
  ('sudan_witness',        'api',     'https://services-eu1.arcgis.com/06WOSMGHsCnaFyMp/arcgis/rest/services/SUW_Incidents/FeatureServer/0', 'https://www.info-res.org/sudan-witness/'),
  ('inso',                 'email',   NULL,                                         'https://ngosafety.org/'),
  ('sudan-war-x',          'webhook', NULL,                                         'https://x.com')
) AS v("name", "type", "url_base", "url_info")
WHERE NOT EXISTS (SELECT 1 FROM "data_sources" d WHERE d."name" = v."name");
