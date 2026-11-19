BEGIN;
DO $$ BEGIN
  IF current_database() <> 'identity_db' THEN RAISE EXCEPTION 'Wrong database'; END IF;
END $$;
SET LOCAL search_path = public;

-- Account emails carry a short numeric code next to the long link token. Only a
-- hash is stored; the code is bound to its user and purpose, and a token stops
-- accepting codes after five wrong guesses. Older rows keep code_hash NULL and
-- can only be used through their link token.
ALTER TABLE one_time_tokens
  ADD COLUMN code_hash varchar(128),
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_one_time_tokens_failed_attempts CHECK (failed_attempts BETWEEN 0 AND 5);

CREATE INDEX ix_one_time_tokens_active_code ON one_time_tokens (user_id, purpose)
  WHERE code_hash IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL;

INSERT INTO schema_migrations(version) VALUES ('V002');
COMMIT;
