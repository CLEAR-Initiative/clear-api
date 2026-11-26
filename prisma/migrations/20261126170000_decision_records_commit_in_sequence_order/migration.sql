-- DecisionRecords commit in sequence order (ADR-0024, #1287).
--
-- The decisions feed reads `sequence > cursor`. A bigserial number is taken
-- when the row is built, before commit, so without this a transaction could
-- hold sequence 10 open while sequence 11 commits; a reader would then pass 10
-- and never see that record.
--
-- Every insert first takes one transaction-scoped advisory lock and only then
-- takes its sequence number. The lock is held until commit or rollback, so a
-- later number can only commit after every earlier one has finished. The
-- column default is evaluated before BEFORE triggers run, so the trigger takes
-- a fresh number under the lock and the default's number becomes a gap (gaps
-- are normal for this feed).
--
-- The key is one fixed 64-bit number: "decision" in ASCII.
CREATE FUNCTION decision_records_take_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7234297680999575406);
  NEW.sequence := nextval(pg_get_serial_sequence('decision_records', 'sequence'));
  RETURN NEW;
END;
$$;

CREATE TRIGGER decision_records_take_sequence
BEFORE INSERT ON "decision_records"
FOR EACH ROW EXECUTE FUNCTION decision_records_take_sequence();
