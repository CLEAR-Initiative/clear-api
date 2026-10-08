-- Event end date is no longer invented (pipeline stops defaulting to start + 7 days);
-- a null `valid_to` now means "ongoing / no known end".
ALTER TABLE "events" ALTER COLUMN "valid_to" DROP NOT NULL;
