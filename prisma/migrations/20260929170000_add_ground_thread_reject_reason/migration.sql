-- Structured reject reason for ground threads (#625). Until now the hotline
-- inbox wrote it into review_note as "<reason>: <localized label>".

-- AlterTable
ALTER TABLE "ground_threads" ADD COLUMN "reject_reason" TEXT;

-- Backfill currently-rejected threads whose note carries a known reason
-- prefix. review_note itself is left untouched.
UPDATE "ground_threads"
SET "reject_reason" = substring("review_note" from '^(spam|not_report|unusable|duplicate):')
WHERE "review_state" = 'rejected'
  AND "review_note" ~ '^(spam|not_report|unusable|duplicate):';
