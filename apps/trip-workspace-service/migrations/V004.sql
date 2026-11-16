-- Additive provider identifier capacity; no existing location is rewritten.
BEGIN;
DO $$ BEGIN IF current_database() <> 'trip_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
ALTER TABLE selected_locations ALTER COLUMN provider_place_id TYPE varchar(2048);
INSERT INTO schema_migrations(version) VALUES ('V004');
COMMIT;
