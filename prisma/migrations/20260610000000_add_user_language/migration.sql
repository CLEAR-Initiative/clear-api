-- Add `language` column to `user` for storing the user's preferred UI language
-- (BCP-47 / ISO 639-1 code, e.g. "en", "ar"). Defaults to "en" so existing
-- rows backfill safely and the frontend always has a value to read.
ALTER TABLE "user" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en';
