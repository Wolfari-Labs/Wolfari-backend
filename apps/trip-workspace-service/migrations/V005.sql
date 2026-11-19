-- Trip budget + private cover image; short join codes for link invitations.
BEGIN;
DO $$ BEGIN IF current_database() <> 'trip_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
ALTER TABLE trips ADD COLUMN budget_amount bigint;
ALTER TABLE trips ADD CONSTRAINT ck_trips_budget CHECK (budget_amount IS NULL OR (budget_amount > 0 AND budget_amount <= 999999999999));
ALTER TABLE trips ADD COLUMN cover_image_key text;
ALTER TABLE trips ADD CONSTRAINT ck_trips_cover_scope CHECK (
  cover_image_key IS NULL OR (
    cover_image_key LIKE 'trips/' || id::text || '/cover/%'
    AND cover_image_key ~ '^trips/[0-9a-f-]{36}/cover/[0-9a-f-]{36}\.jpg$'
  )
);
-- Only a digest is stored; the hint is the last 4 characters shown in pending lists.
ALTER TABLE invitations ADD COLUMN code_hash varchar(128);
ALTER TABLE invitations ADD COLUMN code_hint varchar(4);
ALTER TABLE invitations ADD CONSTRAINT ck_invitations_code CHECK (
  (code_hash IS NULL AND code_hint IS NULL) OR (invitation_type = 'LINK' AND code_hash IS NOT NULL AND code_hint ~ '^[0-9A-HJKMNP-TV-Z]{4}$')
);
CREATE UNIQUE INDEX ux_invitations_code_hash ON invitations(code_hash) WHERE code_hash IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES('V005');
COMMIT;
