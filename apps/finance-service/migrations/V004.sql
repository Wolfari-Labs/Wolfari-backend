BEGIN;
DO $$ BEGIN
  IF current_database() <> 'finance_db' THEN RAISE EXCEPTION 'Wrong database'; END IF;
END $$;
SET LOCAL search_path = public;

-- Refund verification is recorded independently from the member who paid the
-- refund. The payer is the Holder who reported payment; this is stored so a later
-- Holder change cannot turn the payer into their own verifier. Historical
-- confirmations remain unknown (NULL).
ALTER TABLE fund_refunds
  ADD COLUMN holder_reported_by_user_id uuid,
  ADD COLUMN verifier_user_id uuid,
  ADD COLUMN verifier_assigned_by_user_id uuid,
  ADD COLUMN verifier_holder_user_id uuid,
  ADD COLUMN verifier_assigned_at timestamptz,
  ADD COLUMN confirmation_mode text,
  ADD COLUMN independent_verification boolean,
  ADD CONSTRAINT fund_refunds_reporter_requires_report CHECK (
    holder_reported_by_user_id IS NULL OR holder_reported_at IS NOT NULL
  ),
  ADD CONSTRAINT fund_refunds_verifier_assignment_complete CHECK (
    (verifier_user_id IS NULL AND verifier_assigned_by_user_id IS NULL
      AND verifier_holder_user_id IS NULL AND verifier_assigned_at IS NULL)
    OR (verifier_user_id IS NOT NULL AND verifier_assigned_by_user_id IS NOT NULL
      AND verifier_holder_user_id IS NOT NULL AND verifier_assigned_at IS NOT NULL
      AND verifier_user_id <> verifier_holder_user_id)
  ),
  ADD CONSTRAINT fund_refunds_confirmation_verification CHECK (
    (confirmation_mode IS NULL AND independent_verification IS NULL)
    OR (confirmation_mode IS NOT NULL AND independent_verification IS NOT NULL
      AND confirmation_mode IN ('RECIPIENT','OWNER','ASSIGNED_MEMBER')
      AND independent_verification = true AND confirmed_by_user_id IS NOT NULL
      AND confirmed_at IS NOT NULL)
    OR (confirmation_mode IS NOT NULL AND independent_verification IS NOT NULL
      AND confirmation_mode = 'SELF_UNVERIFIED' AND independent_verification = false
      AND confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)
  );

-- Before V005 a Fund never changed Holder, so every reported refund was reported
-- by the Holder current at migration time.
UPDATE fund_refunds r SET holder_reported_by_user_id = f.holder_user_id
  FROM funds f WHERE f.id = r.fund_id AND r.holder_reported_at IS NOT NULL
  AND r.holder_reported_by_user_id IS NULL;

INSERT INTO schema_migrations(version) VALUES ('V004');
COMMIT;
