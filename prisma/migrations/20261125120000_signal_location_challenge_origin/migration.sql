-- Location challenges record who filed them (Exponential #1653): a person in
-- the app, or the pipeline when the place a Signal's text names is in another
-- state than the point its source sent. Existing rows were all filed by
-- people, which the default writes.
CREATE TYPE "signal_location_challenge_origin" AS ENUM ('PERSON', 'PIPELINE');

ALTER TABLE "signal_location_challenges"
    ADD COLUMN "origin" "signal_location_challenge_origin" NOT NULL DEFAULT 'PERSON';
