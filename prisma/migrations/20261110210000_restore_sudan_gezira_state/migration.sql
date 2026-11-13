-- Restore Sudan's Gezira (Al Jazirah) state row, pCode SD15.
--
-- On dev the row was hard-deleted between 14 and 20 June 2026. The parent
-- foreign key is ON DELETE SET NULL, so its 8 districts kept living with
-- `parent_id` NULL and an `ancestor_ids` that still names the deleted id.
-- Points created under them after the delete got `ancestor_ids` = [district]
-- only. The text locator walks parent links from Sudan and never saw the 8
-- districts.
--
-- Data fix, idempotent. It acts only on a database that has Sudan (level 0,
-- pCode SD), has no level-1 SD15 row, and has level-2 SD15 districts with no
-- parent. Prod has the row; an empty or test database has no Sudan. Both are
-- left unchanged.
--
-- The state row gets:
--   - the deleted row's id when every orphan district still names one and
--     the same dead id (so old `ancestor_ids` become valid again), else a
--     new id
--   - the name prod uses ("Gezira")
--   - the union of its districts' polygons (OCHA districts nest in states)
--   - the sum of its districts' populations

DO $$
DECLARE
  sudan_id TEXT;
  state_id TEXT;
BEGIN
  SELECT "id" INTO sudan_id FROM "locations" WHERE "level" = 0 AND "p_code" = 'SD';
  IF sudan_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM "locations" WHERE "level" = 1 AND "p_code" = 'SD15') THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "locations"
    WHERE "level" = 2 AND "p_code" LIKE 'SD15%' AND "parent_id" IS NULL
      AND GeometryType("geometry") = 'MULTIPOLYGON'
  ) THEN
    RETURN;
  END IF;

  SELECT min(d."ancestor_ids"[1]) INTO state_id
  FROM "locations" d
  WHERE d."level" = 2 AND d."p_code" LIKE 'SD15%' AND d."parent_id" IS NULL
  HAVING count(DISTINCT coalesce(d."ancestor_ids"[1], '')) = 1;

  IF state_id = sudan_id OR EXISTS (SELECT 1 FROM "locations" WHERE "id" = state_id) THEN
    state_id := NULL;
  END IF;

  IF state_id IS NULL THEN
    state_id := gen_random_uuid()::text;
  END IF;

  INSERT INTO "locations"
    ("id", "p_code", "name", "level", "parent_id", "ancestor_ids", "geometry", "population")
  SELECT
    state_id, 'SD15', 'Gezira', 1, sudan_id, ARRAY[sudan_id],
    ST_Multi(ST_CollectionExtract(ST_Union(d."geometry"), 3)),
    sum(d."population")::bigint
  FROM "locations" d
  WHERE d."level" = 2 AND d."p_code" LIKE 'SD15%' AND d."parent_id" IS NULL
    AND GeometryType(d."geometry") = 'MULTIPOLYGON';

  UPDATE "locations"
  SET "parent_id" = state_id,
      "ancestor_ids" = ARRAY[state_id, sudan_id],
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "level" = 2 AND "p_code" LIKE 'SD15%' AND "parent_id" IS NULL;

  -- Points filed under the 8 districts: repair the ancestor chain.
  UPDATE "locations" c
  SET "ancestor_ids" = ARRAY[d."id", state_id, sudan_id],
      "updated_at" = CURRENT_TIMESTAMP
  FROM "locations" d
  WHERE c."parent_id" = d."id"
    AND d."parent_id" = state_id
    AND c."ancestor_ids" IS DISTINCT FROM ARRAY[d."id", state_id, sudan_id];
END $$;
