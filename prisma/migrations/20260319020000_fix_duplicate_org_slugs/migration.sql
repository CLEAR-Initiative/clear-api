-- Deduplicate organisation slugs by appending the row number for collisions.
-- Only the first org (by id) keeps the base slug; subsequent duplicates get "-2", "-3", etc.
UPDATE "organisations" o
SET "slug" = o."slug" || '-' || sub.rn::text
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "slug" ORDER BY id) AS rn
  FROM "organisations"
) sub
WHERE o.id = sub.id AND sub.rn > 1;
