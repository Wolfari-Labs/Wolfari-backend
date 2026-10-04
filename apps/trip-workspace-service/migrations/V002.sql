-- Forward-only invitation acceptance and pending-email uniqueness.
BEGIN;
DO $$ BEGIN IF current_database() <> 'trip_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM invitations WHERE status = 'ACCEPTED') THEN
    RAISE EXCEPTION 'INVITATION_ACCEPTANCE_BACKFILL_REQUIRED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM invitations
    WHERE invitation_type = 'EMAIL' AND status = 'PENDING'
    GROUP BY trip_id, lower(btrim(email)) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_PENDING_INVITATIONS';
  END IF;
END $$;

ALTER TABLE invitations ADD COLUMN accepted_member_id uuid;
ALTER TABLE invitations ADD CONSTRAINT invitations_accepted_member_fk
  FOREIGN KEY (accepted_member_id, trip_id) REFERENCES trip_members(id, trip_id);
ALTER TABLE invitations ADD CONSTRAINT invitations_acceptance_link_check
  CHECK ((status = 'ACCEPTED') = (accepted_member_id IS NOT NULL));
CREATE UNIQUE INDEX invitations_pending_email_uq
  ON invitations(trip_id, lower(btrim(email)))
  WHERE invitation_type = 'EMAIL' AND status = 'PENDING';
CREATE INDEX invitations_pending_expiry_idx ON invitations(expires_at, trip_id)
  WHERE status = 'PENDING';

INSERT INTO schema_migrations(version) VALUES ('V002');
COMMIT;
