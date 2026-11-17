BEGIN;
DO $$ BEGIN
  IF current_database() <> 'finance_db' THEN RAISE EXCEPTION 'Wrong database'; END IF;
END $$;
SET LOCAL search_path = public;

-- Incoming bank transfers reported by a bank-aggregation provider (SePay first).
-- One row per provider transaction; a MATCHED row confirmed exactly one contribution.
CREATE TABLE bank_transfer_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(30) NOT NULL,
  provider_transaction_id varchar(150) NOT NULL,
  transfer_type varchar(8) NOT NULL,
  amount bigint NOT NULL,
  content text NOT NULL,
  account_number varchar(80) NOT NULL,
  bank_gateway varchar(80),
  reference_code varchar(150),
  sub_account varchar(80),
  transaction_at timestamptz,
  payload jsonb NOT NULL,
  processing_status varchar(20) NOT NULL,
  review_reason varchar(60),
  fund_id uuid REFERENCES funds(id),
  contribution_id uuid,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  CONSTRAINT ck_bank_transfer_receipts_1 CHECK (transfer_type IN ('IN','OUT')),
  CONSTRAINT ck_bank_transfer_receipts_2 CHECK (amount > 0),
  CONSTRAINT ck_bank_transfer_receipts_3 CHECK (processing_status IN ('MATCHED','UNMATCHED','NEEDS_REVIEW','IGNORED')),
  CONSTRAINT ck_bank_transfer_receipts_4 CHECK ((processing_status = 'MATCHED') = (contribution_id IS NOT NULL)),
  CONSTRAINT ck_bank_transfer_receipts_5 CHECK (contribution_id IS NULL OR fund_id IS NOT NULL),
  CONSTRAINT uq_bank_transfer_receipts_1 UNIQUE (provider, provider_transaction_id),
  CONSTRAINT fk_bank_transfer_receipts_2 FOREIGN KEY (contribution_id, fund_id) REFERENCES contributions (id, fund_id)
);
CREATE INDEX bank_transfer_receipts_fund_idx ON bank_transfer_receipts(fund_id, received_at DESC, id DESC);
INSERT INTO schema_migrations(version) VALUES ('V006');
COMMIT;
