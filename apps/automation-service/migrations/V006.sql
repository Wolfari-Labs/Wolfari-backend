-- Wolfari automation_db | V006 | durable Finance terminal inbox lookup
BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;

-- These committed inbox rows also act as deny-only terminal barriers.
-- Do not purge them without a separately approved durable replacement/retention design.
CREATE INDEX ix_inbox_events_finance_terminal
  ON inbox_events (consumer_name,aggregate_id,event_type,(result->>'closure_id'))
  WHERE event_type IN ('ClosureCancelled','FinanceClosed');

INSERT INTO schema_migrations(version) VALUES ('V006');
COMMIT;
