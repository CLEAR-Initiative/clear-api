-- Add `disaster_types.nrc_relevant`: whether an event/disaster type is relevant
-- to NRC analysts. Source of truth: the "Add out-of-interest event types" doc
-- ("Relevant to NRC" column), keyed by the glide code (`glide_number`).
--
-- Defaults false (out-of-interest until explicitly marked). The UPDATE flips the
-- 40 codes marked "Yes" to true; the 12 "No" codes stay false — arrests (pa),
-- change to group or activity (pg), disrupted weapons use (pw), excessive force
-- against protesters (pf), grenade (rg), headquarters or base established (ph),
-- non-violent transfer of territory (pt), conflict "other" (po), peaceful
-- protest (pp), violent demonstration (rd), fire (fr), natural "other" (ot).
--
-- The doc's legacy `vc` code (abduction/forced disappearance, remapped to `va`)
-- is not a current disaster_types row, so it is intentionally not referenced.

ALTER TABLE "disaster_types" ADD COLUMN "nrc_relevant" BOOLEAN NOT NULL DEFAULT false;

UPDATE "disaster_types"
SET "nrc_relevant" = true
WHERE "glide_number" IN (
  'cw','ht','ce','dr','eq','ep','ec','ff','fl','in','sl','ls','ms','av','st','ac',
  'to','tc','ss','ts','vo','wf','vw','pi','ba','bg','bo','ri','rc','rs','rm','rl',
  'rb','va','vs','vd','pv','pl','fc','fa'
);
