BEGIN;
DO $$ BEGIN
  IF current_database() <> 'finance_db' THEN RAISE EXCEPTION 'Wrong database'; END IF;
END $$;
SET LOCAL search_path = public;

-- Finance-owned private objects. Binding survives replacement of the current evidence key.
CREATE TABLE finance_files (
  object_key text PRIMARY KEY,
  fund_id uuid NOT NULL REFERENCES funds(id),
  uploader_user_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','application/pdf')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  state text NOT NULL DEFAULT 'UPLOADING' CHECK (state IN ('UPLOADING','READY','DELETING')),
  contribution_id uuid,
  expense_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  bound_at timestamptz,
  cleanup_after timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  FOREIGN KEY (contribution_id, fund_id) REFERENCES contributions(id, fund_id),
  FOREIGN KEY (expense_id, fund_id) REFERENCES fund_expenses(id, fund_id),
  CHECK (num_nonnulls(contribution_id, expense_id) <= 1),
  CHECK ((bound_at IS NULL) = (contribution_id IS NULL AND expense_id IS NULL)),
  CHECK (bound_at IS NULL OR state = 'READY')
);
CREATE INDEX finance_files_cleanup_idx ON finance_files(cleanup_after, object_key)
  WHERE bound_at IS NULL;

CREATE FUNCTION protect_finance_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'File history is retained'; END IF;
  IF ROW(NEW.object_key,NEW.fund_id,NEW.uploader_user_id,NEW.sha256,NEW.mime_type,NEW.size_bytes,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.object_key,OLD.fund_id,OLD.uploader_user_id,OLD.sha256,OLD.mime_type,OLD.size_bytes,OLD.created_at)
  THEN RAISE EXCEPTION 'File identity is immutable'; END IF;
  IF OLD.bound_at IS NOT NULL AND ROW(NEW.contribution_id,NEW.expense_id,NEW.bound_at,NEW.state)
     IS DISTINCT FROM ROW(OLD.contribution_id,OLD.expense_id,OLD.bound_at,OLD.state)
  THEN RAISE EXCEPTION 'File binding is immutable'; END IF;
  IF OLD.state = 'DELETING' AND NEW.state <> 'DELETING'
  THEN RAISE EXCEPTION 'File deletion is irreversible'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_file_history BEFORE UPDATE OR DELETE ON finance_files
  FOR EACH ROW EXECUTE FUNCTION protect_finance_file();

INSERT INTO schema_migrations(version) VALUES ('V002');
COMMIT;
