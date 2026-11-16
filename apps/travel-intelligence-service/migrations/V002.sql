BEGIN;
DO $$ BEGIN IF current_database() <> 'travel_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
CREATE TABLE provider_usage (
  provider varchar(50) PRIMARY KEY,
  usage_day date NOT NULL,
  calls integer NOT NULL CHECK (calls >= 0),
  last_call_at timestamptz NOT NULL
);
INSERT INTO schema_migrations(version) VALUES ('V002');
COMMIT;
