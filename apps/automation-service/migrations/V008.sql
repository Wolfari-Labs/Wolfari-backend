-- Bind push devices to the authenticated session family, including refresh rotation.
BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;
ALTER TABLE device_tokens ADD COLUMN session_family_id uuid;
-- Old registrations must register again before delivery; never infer a session binding.
UPDATE device_tokens SET active=false,updated_at=clock_timestamp();
INSERT INTO schema_migrations(version) VALUES ('V008');
COMMIT;
