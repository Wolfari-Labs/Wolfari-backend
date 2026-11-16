BEGIN;
DO $$ BEGIN
  IF current_database() <> 'finance_db' THEN RAISE EXCEPTION 'Wrong database'; END IF;
END $$;
SET LOCAL search_path = public;

CREATE TABLE fund_holder_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL REFERENCES funds(id),
  old_holder_user_id uuid NOT NULL,
  new_holder_user_id uuid NOT NULL,
  nominated_by_user_id uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'NOMINATED',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  snapshot_finance_version integer,
  snapshot jsonb,
  accepted_at timestamptz,
  old_holder_confirmed_at timestamptz,
  new_holder_confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason varchar(1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (old_holder_user_id <> new_holder_user_id),
  CHECK (status IN ('NOMINATED','ACCEPTED','COMPLETED','CANCELLED')),
  CHECK ((snapshot_finance_version IS NULL) = (snapshot IS NULL)),
  CHECK (snapshot_finance_version IS NULL OR snapshot_finance_version > 0),
  CHECK (status NOT IN ('ACCEPTED','COMPLETED') OR (snapshot IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (status <> 'COMPLETED' OR (old_holder_confirmed_at IS NOT NULL AND new_holder_confirmed_at IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL))
);
CREATE UNIQUE INDEX fund_holder_handovers_one_active_idx ON fund_holder_handovers(fund_id)
  WHERE status IN ('NOMINATED','ACCEPTED');
CREATE INDEX fund_holder_handovers_history_idx ON fund_holder_handovers(fund_id,created_at DESC,id DESC);
INSERT INTO schema_migrations(version) VALUES ('V005');
COMMIT;
