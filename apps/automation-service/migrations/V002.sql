-- Wolfari automation_db | V002 | bind Price Watch ownership to one membership lifecycle
BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;

-- No Price Watch writer existed before this migration. Do not guess a membership
-- for manually inserted or future backfilled rows: an operator must resolve them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM price_watches) THEN
    RAISE EXCEPTION 'PRICE_WATCH_MEMBERSHIP_BACKFILL_REQUIRED';
  END IF;
END $$;

ALTER TABLE price_watches ADD COLUMN owner_membership_id uuid NOT NULL;
COMMENT ON COLUMN price_watches.owner_membership_id IS
  'Logical reference to Trip.trip_members; distinguishes a departed membership from a later rejoin';
CREATE INDEX ix_price_watches_2 ON price_watches (trip_id, owner_membership_id, status);

INSERT INTO schema_migrations(version) VALUES ('V002');
COMMIT;
