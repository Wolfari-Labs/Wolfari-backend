-- Optional private dress-code reference image. Existing dress codes remain unchanged.
BEGIN;
DO $$ BEGIN IF current_database() <> 'trip_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
ALTER TABLE dress_codes ADD COLUMN reference_image_key text;
ALTER TABLE dress_codes ADD CONSTRAINT ck_dress_reference_image_scope CHECK (
  reference_image_key IS NULL OR (
    reference_image_key LIKE 'trips/' || trip_id::text || '/dress-images/%'
    AND reference_image_key ~ '^trips/[0-9a-f-]{36}/dress-images/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
  )
);
CREATE INDEX ix_dress_reference_image ON dress_codes(reference_image_key) WHERE reference_image_key IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES('V004');
COMMIT;
