BEGIN;
DO $$ BEGIN
  IF current_database() <> 'finance_db' THEN RAISE EXCEPTION 'Wrong database'; END IF;
END $$;
SET LOCAL search_path = public;

-- The Holder closes each NEEDS_REVIEW bank transfer with a recorded outcome.
-- Resolving never moves money: refunds/contributions already have their own writers.
ALTER TABLE bank_transfer_receipts
  ADD COLUMN resolution varchar(30),
  ADD COLUMN resolution_note text,
  ADD COLUMN resolved_by_user_id uuid,
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolution_operation_id uuid;
ALTER TABLE bank_transfer_receipts DROP CONSTRAINT ck_bank_transfer_receipts_3;
ALTER TABLE bank_transfer_receipts
  ADD CONSTRAINT ck_bank_transfer_receipts_3 CHECK (processing_status IN ('MATCHED','UNMATCHED','NEEDS_REVIEW','IGNORED','RESOLVED')),
  ADD CONSTRAINT ck_bank_transfer_receipts_6 CHECK (resolution IS NULL OR resolution IN ('RETURNED_TO_SENDER','HANDLED_IN_APP','NOT_OURS')),
  ADD CONSTRAINT ck_bank_transfer_receipts_7 CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 500),
  ADD CONSTRAINT ck_bank_transfer_receipts_8 CHECK (
    (processing_status = 'RESOLVED') = (
      resolution IS NOT NULL AND resolution_note IS NOT NULL AND resolved_by_user_id IS NOT NULL
      AND resolved_at IS NOT NULL AND resolution_operation_id IS NOT NULL AND fund_id IS NOT NULL
    )
  );
CREATE INDEX bank_transfer_receipts_review_idx ON bank_transfer_receipts(fund_id) WHERE processing_status = 'NEEDS_REVIEW';
INSERT INTO schema_migrations(version) VALUES ('V007');
COMMIT;
