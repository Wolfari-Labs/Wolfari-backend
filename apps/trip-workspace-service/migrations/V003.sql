-- Demo 1 additive day-only Activity scheduling. Never infer dates for old rows.
BEGIN;
DO $$ BEGIN IF current_database() <> 'trip_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;

ALTER TABLE activities ADD COLUMN scheduled_date date;
ALTER TABLE activities ADD CONSTRAINT ck_activities_scheduled_date
  CHECK (scheduled_date IS NULL OR
    (starts_at IS NULL AND ends_at IS NULL
     AND scheduled_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'));
COMMENT ON COLUMN activities.scheduled_date IS
  'Calendar day in Trip timezone, only for untimed activities; NULL means unscheduled or timed.';

INSERT INTO schema_migrations(version) VALUES ('V003');
COMMIT;
