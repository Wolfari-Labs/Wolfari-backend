BEGIN;
DO $$ BEGIN
  IF current_database() <> 'finance_db' THEN RAISE EXCEPTION 'Wrong database'; END IF;
END $$;
SET LOCAL search_path = public;

-- payOS VietQR payment links: real (LIVE) transfers that settle straight into the Holder's own
-- bank account, which must be the contribution destination. Additive only: MoMo Sandbox rows and
-- the existing lock, ledger and receipt rules are unchanged.
ALTER TABLE payment_attempts DROP CONSTRAINT ck_payment_attempts_3,
  ADD CONSTRAINT ck_payment_attempts_3 CHECK (provider IN ('MOMO_SANDBOX','VIETQR','PAYOS'));
ALTER TABLE payment_attempts DROP CONSTRAINT ck_payment_attempts_4,
  ADD CONSTRAINT ck_payment_attempts_4 CHECK (environment IN ('SANDBOX','TEST','LIVE'));
INSERT INTO schema_migrations(version) VALUES ('V008');
COMMIT;
