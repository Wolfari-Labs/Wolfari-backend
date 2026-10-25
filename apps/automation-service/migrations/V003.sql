-- Wolfari automation_db | V003 | durable Price Watch retry scheduling
BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;

ALTER TABLE price_query_attempts ADD COLUMN next_attempt_at timestamptz;
UPDATE price_query_attempts SET next_attempt_at=created_at WHERE next_attempt_at IS NULL;
ALTER TABLE price_query_attempts ALTER COLUMN next_attempt_at SET DEFAULT now();
ALTER TABLE price_query_attempts ALTER COLUMN next_attempt_at SET NOT NULL;

CREATE INDEX ix_price_query_attempts_1
  ON price_query_attempts (status, next_attempt_at, claim_until, scheduled_slot)
  WHERE status IN ('PENDING','RUNNING');

INSERT INTO schema_migrations(version) VALUES ('V003');
COMMIT;
