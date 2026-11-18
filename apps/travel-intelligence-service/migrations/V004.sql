-- Wolfari travel_db | V004 | POI-OVERTURE: provenance per POI for the nationwide Overture tier.
-- Additive only. Rows loaded before V004 (golden snapshots) keep NULL here and read as golden.
BEGIN;
DO $$ BEGIN IF current_database() <> 'travel_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;

ALTER TABLE pois
  ADD COLUMN source_dataset varchar(20) CHECK (source_dataset IN ('golden', 'overture')),
  ADD COLUMN source_release varchar(20),
  ADD COLUMN fetched_at timestamptz;

INSERT INTO schema_migrations(version) VALUES ('V004');
COMMIT;
