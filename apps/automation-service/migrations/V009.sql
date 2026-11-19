BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
CREATE TABLE price_provider_limits (
  provider varchar(50) PRIMARY KEY,
  next_call_at timestamptz NOT NULL
);
INSERT INTO schema_migrations(version) VALUES ('V009');
COMMIT;
