BEGIN;
DO $$ BEGIN
  IF current_database() <> 'finance_db' THEN RAISE EXCEPTION 'Wrong database'; END IF;
END $$;
SET LOCAL search_path = public;

-- Member history uses a deterministic descending keyset, preserving microseconds.
CREATE INDEX finance_audit_history_idx
  ON finance_audit_logs(fund_id, occurred_at DESC, id DESC);

INSERT INTO schema_migrations(version) VALUES ('V003');
COMMIT;
