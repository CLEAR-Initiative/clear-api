-- CreateEnum
CREATE TYPE "EstimateMetric" AS ENUM ('people_affected', 'people_displaced_new', 'people_displaced_cumulative', 'people_in_need', 'people_targeted', 'people_reached', 'households_affected');

-- CreateEnum
CREATE TYPE "EstimateMethod" AS ENUM ('exposure_model', 'model_inference', 'rapid_assessment', 'formal_assessment', 'registration', 'field_staff_judgement', 'partner_or_cluster_figure', 'prior_caseload_analogue', 'government_figure', 'media_report', 'not_documented');

-- CreateEnum
CREATE TYPE "EstimateAttribution" AS ENUM ('event_caused', 'pre_existing', 'combined');

-- CreateTable
CREATE TABLE "estimates" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "metric" "EstimateMetric" NOT NULL,
    "population_group" TEXT,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "lower_bound" DOUBLE PRECISION,
    "upper_bound" DOUBLE PRECISION,
    "method" "EstimateMethod" NOT NULL,
    "attribution" "EstimateAttribution" NOT NULL,
    "valid_for" TIMESTAMP(3) NOT NULL,
    "estimated_at" TIMESTAMP(3) NOT NULL,
    "is_ground_truth" BOOLEAN NOT NULL DEFAULT false,
    "source_signal_id" TEXT,
    "source_url" TEXT,
    "supersedes_id" TEXT,
    "definition_version" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estimates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "estimates_supersedes_id_key" ON "estimates"("supersedes_id");

-- CreateIndex
CREATE INDEX "estimates_event_id_metric_estimated_at_idx" ON "estimates"("event_id", "metric", "estimated_at");

-- CreateIndex
CREATE INDEX "estimates_source_signal_id_idx" ON "estimates"("source_signal_id");

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "estimates"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_source_signal_id_fkey" FOREIGN KEY ("source_signal_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Rules Prisma can't express ──────────────────────────────────────────

-- The ontology's rule `lower_bound ≤ value ≤ upper_bound`, where bounds are
-- present (either may be absent on its own).
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_bounds_check" CHECK (
  ("lower_bound" IS NULL OR "lower_bound" <= "value")
  AND ("upper_bound" IS NULL OR "value" <= "upper_bound")
);

-- Never overwrite an Estimate: a correction is a new row whose
-- `supersedes_id` points at this one. Nothing may change on an existing row,
-- `supersedes_id` included (clearing it would make the corrected figure
-- current again). The one exception is the ON DELETE SET NULL actions of the
-- `source_signal_id` and `created_by_id` foreign keys when that Signal or
-- user is deleted: those run inside the RI trigger, so pg_trigger_depth() is
-- above 1, whereas a direct UPDATE fires this trigger at depth 1.
CREATE FUNCTION "estimates_immutable"() RETURNS trigger AS $$
BEGIN
  IF (NEW."id", NEW."event_id", NEW."metric", NEW."population_group", NEW."value",
      NEW."unit", NEW."lower_bound", NEW."upper_bound", NEW."method",
      NEW."attribution", NEW."valid_for", NEW."estimated_at", NEW."is_ground_truth",
      NEW."source_url", NEW."supersedes_id", NEW."definition_version", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."event_id", OLD."metric", OLD."population_group", OLD."value",
      OLD."unit", OLD."lower_bound", OLD."upper_bound", OLD."method",
      OLD."attribution", OLD."valid_for", OLD."estimated_at", OLD."is_ground_truth",
      OLD."source_url", OLD."supersedes_id", OLD."definition_version", OLD."created_at")
     OR (NEW."source_signal_id" IS DISTINCT FROM OLD."source_signal_id"
         AND (NEW."source_signal_id" IS NOT NULL OR pg_trigger_depth() <= 1))
     OR (NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
         AND (NEW."created_by_id" IS NOT NULL OR pg_trigger_depth() <= 1))
  THEN
    RAISE EXCEPTION 'estimates are never overwritten: insert a new row with supersedes_id = %', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "estimates_immutable"
  BEFORE UPDATE ON "estimates"
  FOR EACH ROW EXECUTE FUNCTION "estimates_immutable"();

-- A correction is of the same figure: same Event, metric and population
-- group as the Estimate it supersedes. Otherwise it would retire a figure
-- it does not replace, and `Event.estimates(current: true)` would drop it.
-- The superseded row is immutable, so this check cannot go stale.
CREATE FUNCTION "estimates_supersede_same_figure"() RETURNS trigger AS $$
DECLARE
  prev RECORD;
BEGIN
  IF NEW."supersedes_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "event_id", "metric", "population_group" INTO prev
    FROM "estimates" WHERE "id" = NEW."supersedes_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'estimate % supersedes %, which does not exist', NEW."id", NEW."supersedes_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF (prev."event_id", prev."metric", prev."population_group")
     IS DISTINCT FROM (NEW."event_id", NEW."metric", NEW."population_group") THEN
    RAISE EXCEPTION 'an estimate can only supersede one of the same event, metric and population group (supersedes %)', NEW."supersedes_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "estimates_supersede_same_figure"
  BEFORE INSERT ON "estimates"
  FOR EACH ROW EXECUTE FUNCTION "estimates_supersede_same_figure"();

-- ─── One-off backfill from the Event scalars ─────────────────────────────
--
-- So existing Events contribute to ImpactPriors on day one. One Estimate per
-- non-null scalar, with this mapping:
--
--   events.population_affected  → people_affected
--   events.population_displaced → people_displaced_new (the pipeline counts
--                                 people displaced BY the event — IDMC IDU
--                                 flows, figures in the signal text — never
--                                 a district's standing IDP stock; DTM is
--                                 excluded on purpose)
--   events.casualties           → not backfilled. The ontology's seven
--                                 metrics have no mortality figure, and the
--                                 column mixes fatalities, text-extracted
--                                 "casualties" (killed and/or injured) and
--                                 ACLED q75 fallbacks, summed across signals.
--                                 It stays on `events`; a `people_killed`
--                                 metric is raised with the ontology owner.
--
-- Every row: method `not_documented` (the pipeline does not record, per
-- Event, whether a figure came from the source, an LLM read of the text or a
-- per-type historical lookup), attribution `event_caused` (both are figures
-- of impact by this Event), unit `people`, no bounds, not ground truth,
-- definition_version `0.3.0`.
--
-- valid_for = the Event's last_signal_created_at: the scalar is the
-- aggregate over every signal attached by then. estimated_at = now: CLEAR
-- recomputes the scalars on each signal and kept no history, so the only
-- moment it is certain CLEAR held this figure is the backfill itself.
--
-- The pipeline's last-resort constants (clear-pipeline signals/config.py:
-- default_population_affected = 33000, default_population_displaced = 1670,
-- unchanged since introduced) are placeholders for "no figure", not figures,
-- and are skipped: as Estimates they would feed a constant into every prior.
--
-- Ids are deterministic so a re-run (or a manual replay) inserts nothing new.
INSERT INTO "estimates" (
  "id", "event_id", "metric", "value", "unit", "method", "attribution",
  "valid_for", "estimated_at", "definition_version"
)
SELECT
  'est_bf_' || md5(e."id" || ':people_affected'),
  e."id", 'people_affected'::"EstimateMetric", e."population_affected"::double precision, 'people',
  'not_documented'::"EstimateMethod", 'event_caused'::"EstimateAttribution", e."last_signal_created_at", CURRENT_TIMESTAMP, '0.3.0'
FROM "events" e
WHERE e."population_affected" IS NOT NULL AND e."population_affected" <> 33000
UNION ALL
SELECT
  'est_bf_' || md5(e."id" || ':people_displaced_new'),
  e."id", 'people_displaced_new'::"EstimateMetric", e."population_displaced"::double precision, 'people',
  'not_documented'::"EstimateMethod", 'event_caused'::"EstimateAttribution", e."last_signal_created_at", CURRENT_TIMESTAMP, '0.3.0'
FROM "events" e
WHERE e."population_displaced" IS NOT NULL AND e."population_displaced" <> 1670
ON CONFLICT ("id") DO NOTHING;
