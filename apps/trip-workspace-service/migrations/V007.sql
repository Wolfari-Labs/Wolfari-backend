-- Reusable LINK invitations: the Owner may let one link/code admit several people (a group link),
-- and every admission is recorded once. EMAIL invitations stay single-use and bound to one address.
BEGIN;
DO $$ BEGIN IF current_database() <> 'trip_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
ALTER TABLE invitations ADD COLUMN max_uses integer NOT NULL DEFAULT 1;
ALTER TABLE invitations ADD COLUMN use_count integer NOT NULL DEFAULT 0;
-- Existing accepted invitations were used exactly once.
UPDATE invitations SET use_count = 1 WHERE status = 'ACCEPTED';
ALTER TABLE invitations ADD CONSTRAINT ck_invitations_uses CHECK (
  max_uses BETWEEN 1 AND 50
  AND use_count BETWEEN 0 AND max_uses
  AND (invitation_type = 'LINK' OR max_uses = 1)
);
CREATE TABLE invitation_acceptances (
  invitation_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  member_id uuid NOT NULL,
  user_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_invitation_acceptances PRIMARY KEY (invitation_id, member_id),
  CONSTRAINT uq_invitation_acceptances_member UNIQUE (member_id),
  CONSTRAINT fk_invitation_acceptances_invitation FOREIGN KEY (invitation_id) REFERENCES invitations (id),
  CONSTRAINT fk_invitation_acceptances_member FOREIGN KEY (member_id, trip_id) REFERENCES trip_members (id, trip_id)
);
CREATE INDEX ix_invitation_acceptances_user ON invitation_acceptances (invitation_id, user_id);
INSERT INTO invitation_acceptances(invitation_id, trip_id, member_id, user_id, accepted_at)
  SELECT i.id, i.trip_id, i.accepted_member_id, m.user_id, coalesce(i.resolved_at, m.joined_at)
  FROM invitations i JOIN trip_members m ON m.id = i.accepted_member_id AND m.trip_id = i.trip_id
  WHERE i.status = 'ACCEPTED';
-- Pending EMAIL invitations are read by recipient address for the in-app "pending invitations" list.
CREATE INDEX ix_invitations_pending_email ON invitations (lower(btrim(email)))
  WHERE invitation_type = 'EMAIL' AND status = 'PENDING';
INSERT INTO schema_migrations(version) VALUES ('V007');
COMMIT;
