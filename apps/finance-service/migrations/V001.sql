-- Wolfari finance_db | V001 | schema baseline 1.1
-- Run once on an empty database using its owner. No cross-database SQL.
BEGIN;
DO $$ BEGIN IF current_database() <> 'finance_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO finance_app;
SET LOCAL search_path = public;
CREATE TABLE schema_migrations (version varchar(30) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- Quỹ của Trip và số dư cache được cập nhật cùng ledger.
CREATE TABLE funds (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  holder_user_id uuid NOT NULL,
  currency char(3) NOT NULL DEFAULT 'VND',
  budget_amount bigint,
  current_balance bigint NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL DEFAULT 'OPEN',
  finance_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT pk_funds PRIMARY KEY (id),
  CONSTRAINT ck_funds_1 CHECK (finance_version > 0),
  CONSTRAINT ck_funds_2 CHECK (currency='VND'),
  CONSTRAINT ck_funds_3 CHECK (status IN ('OPEN','CLOSING','CLOSED')),
  CONSTRAINT ck_funds_4 CHECK (current_balance >= 0),
  CONSTRAINT ck_funds_5 CHECK (budget_amount >= 0),
  CONSTRAINT uq_funds_1 UNIQUE (trip_id)
);

-- Điểm nhận tiền của Holder dùng cho VietQR/đóng góp.
CREATE TABLE payment_destinations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  destination_type varchar(20) NOT NULL,
  bank_code varchar(30),
  account_number varchar(80),
  account_name varchar(150),
  momo_phone varchar(30),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by_holder_at timestamptz,
  CONSTRAINT pk_payment_destinations PRIMARY KEY (id),
  CONSTRAINT ck_payment_destinations_1 CHECK (version > 0),
  CONSTRAINT ck_payment_destinations_2 CHECK (destination_type IN ('VIETQR','MOMO_SANDBOX')),
  CONSTRAINT ck_payment_destinations_3 CHECK ((destination_type='VIETQR' AND bank_code IS NOT NULL AND account_number IS NOT NULL AND account_name IS NOT NULL) OR (destination_type='MOMO_SANDBOX' AND momo_phone IS NOT NULL))
);

-- Đợt kêu gọi đóng góp do Owner tạo; mỗi người có số tiền riêng.
CREATE TABLE contribution_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  title varchar(200) NOT NULL,
  amount_per_member bigint,
  due_at timestamptz,
  status varchar(16) NOT NULL DEFAULT 'OPEN',
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  note text,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT pk_contribution_requests PRIMARY KEY (id),
  CONSTRAINT ck_contribution_requests_1 CHECK (version > 0),
  CONSTRAINT ck_contribution_requests_2 CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
  CONSTRAINT ck_contribution_requests_3 CHECK (amount_per_member > 0),
  CONSTRAINT uq_contribution_requests_1 UNIQUE (id, fund_id)
);

-- Nghĩa vụ và xác nhận khoản đóng của một thành viên.
CREATE TABLE contributions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  fund_id uuid NOT NULL,
  member_user_id uuid NOT NULL,
  amount bigint NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  destination_snapshot jsonb NOT NULL,
  destination_version integer NOT NULL,
  member_reported_at timestamptz,
  confirmed_by_user_id uuid,
  confirmed_at timestamptz,
  waived_reason text,
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  self_contribution boolean NOT NULL DEFAULT false,
  transfer_evidence_object_key text,
  rejected_reason text,
  waived_at timestamptz,
  cancelled_at timestamptz,
  reversed_at timestamptz,
  CONSTRAINT pk_contributions PRIMARY KEY (id),
  CONSTRAINT ck_contributions_1 CHECK (version > 0),
  CONSTRAINT ck_contributions_2 CHECK (status IN ('PENDING','TRANSFER_REPORTED','CONFIRMED','WAIVED','CANCELLED','REVERSED')),
  CONSTRAINT ck_contributions_3 CHECK (amount > 0),
  CONSTRAINT uq_contributions_1 UNIQUE (id, fund_id),
  CONSTRAINT uq_contributions_2 UNIQUE (request_id, member_user_id)
);

-- Mỗi lần thử MoMo Sandbox hoặc VietQR; không đồng nhất với Contribution.
CREATE TABLE payment_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contribution_id uuid NOT NULL,
  provider varchar(30) NOT NULL,
  environment varchar(16) NOT NULL,
  amount bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'VND',
  client_request_id varchar(100) NOT NULL,
  provider_transaction_id varchar(150),
  status varchar(20) NOT NULL DEFAULT 'CREATED',
  provider_payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  merchant_id varchar(100) NOT NULL,
  provider_order_id varchar(100) NOT NULL,
  destination_snapshot jsonb NOT NULL,
  needs_reconciliation boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  reconciled_at timestamptz,
  error_code varchar(60),
  CONSTRAINT pk_payment_attempts PRIMARY KEY (id),
  CONSTRAINT ck_payment_attempts_1 CHECK (currency='VND'),
  CONSTRAINT ck_payment_attempts_2 CHECK (status IN ('CREATED','PENDING','SUCCEEDED','FAILED','EXPIRED')),
  CONSTRAINT ck_payment_attempts_3 CHECK (provider IN ('MOMO_SANDBOX','VIETQR')),
  CONSTRAINT ck_payment_attempts_4 CHECK (environment IN ('SANDBOX','TEST')),
  CONSTRAINT ck_payment_attempts_5 CHECK (amount > 0),
  CONSTRAINT uq_payment_attempts_1 UNIQUE (provider, environment, client_request_id),
  CONSTRAINT uq_payment_attempts_2 UNIQUE (provider, environment, provider_order_id)
);

-- Dedupe và đối soát callback provider; ngoại lệ nằm trên receipt để không tạo bảng thừa.
CREATE TABLE payment_webhook_receipts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider varchar(30) NOT NULL,
  environment varchar(16) NOT NULL,
  dedupe_key varchar(180) NOT NULL,
  payment_attempt_id uuid,
  signature_valid boolean NOT NULL,
  received_amount bigint,
  payload jsonb NOT NULL,
  processing_status varchar(20) NOT NULL,
  review_reason text,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT pk_payment_webhook_receipts PRIMARY KEY (id),
  CONSTRAINT ck_payment_webhook_receipts_1 CHECK (processing_status IN ('RECEIVED','PROCESSED','IGNORED','NEEDS_REVIEW')),
  CONSTRAINT uq_payment_webhook_receipts_1 UNIQUE (provider, environment, dedupe_key)
);

-- Đề nghị chi và xác nhận bởi Holder.
CREATE TABLE fund_expenses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  title varchar(200) NOT NULL,
  description text,
  amount bigint NOT NULL,
  receipt_object_key text,
  status varchar(16) NOT NULL DEFAULT 'DRAFT',
  created_by_user_id uuid NOT NULL,
  submitted_at timestamptz,
  confirmed_by_user_id uuid,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  category varchar(80),
  paid_at timestamptz,
  payment_method varchar(30),
  paid_by_user_id uuid,
  rejected_reason text,
  deleted_at timestamptz,
  source varchar(20) NOT NULL DEFAULT 'MANUAL',
  CONSTRAINT pk_fund_expenses PRIMARY KEY (id),
  CONSTRAINT ck_fund_expenses_1 CHECK (version > 0),
  CONSTRAINT ck_fund_expenses_2 CHECK (status IN ('DRAFT','SUBMITTED','CONFIRMED','REJECTED','REVERSED')),
  CONSTRAINT ck_fund_expenses_3 CHECK (deleted_at IS NULL OR status='DRAFT'),
  CONSTRAINT ck_fund_expenses_4 CHECK (amount > 0),
  CONSTRAINT uq_fund_expenses_1 UNIQUE (id, fund_id)
);

-- Ghi chú chi ngoài quỹ; không tác động ledger.
CREATE TABLE financial_notes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  payer_user_id uuid,
  amount bigint,
  description text NOT NULL,
  created_by_user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT pk_financial_notes PRIMARY KEY (id),
  CONSTRAINT ck_financial_notes_1 CHECK (version > 0),
  CONSTRAINT ck_financial_notes_2 CHECK (amount >= 0)
);

-- Hoàn dư cho thành viên; giữ chỗ số dư khi chờ Holder báo đã trả.
CREATE TABLE fund_refunds (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  member_user_id uuid NOT NULL,
  amount bigint NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  reason text NOT NULL,
  requested_by_user_id uuid NOT NULL,
  holder_reported_at timestamptz,
  confirmed_by_user_id uuid,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  nonreceipt_confirmed_at timestamptz,
  reversal_consented_at timestamptz,
  reversal_requested_at timestamptz,
  reversal_reason text,
  cancelled_reason text,
  CONSTRAINT pk_fund_refunds PRIMARY KEY (id),
  CONSTRAINT ck_fund_refunds_1 CHECK (version > 0),
  CONSTRAINT ck_fund_refunds_2 CHECK (status IN ('PENDING','HOLDER_REPORTED','CONFIRMED','CANCELLED','REVERSED')),
  CONSTRAINT ck_fund_refunds_3 CHECK (amount > 0),
  CONSTRAINT uq_fund_refunds_1 UNIQUE (id, fund_id)
);

-- Sổ cái append-only, nguồn chuẩn của biến động quỹ.
CREATE TABLE fund_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  sequence bigint NOT NULL,
  direction char(3) NOT NULL,
  transaction_type varchar(20) NOT NULL,
  amount bigint NOT NULL,
  balance_after bigint NOT NULL,
  contribution_id uuid,
  expense_id uuid,
  refund_id uuid,
  reversal_of_id uuid,
  actor_user_id uuid,
  reason text,
  business_key varchar(180) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_fund_transactions PRIMARY KEY (id),
  CONSTRAINT ck_fund_transactions_1 CHECK (amount > 0),
  CONSTRAINT ck_fund_transactions_2 CHECK (sequence > 0),
  CONSTRAINT ck_fund_transactions_3 CHECK (balance_after >= 0),
  CONSTRAINT ck_fund_transactions_4 CHECK (direction IN ('IN','OUT')),
  CONSTRAINT ck_fund_transactions_5 CHECK (transaction_type IN ('CONTRIBUTION','EXPENSE','REFUND','REVERSAL')),
  CONSTRAINT ck_fund_transactions_6 CHECK ((transaction_type='CONTRIBUTION' AND direction='IN' AND contribution_id IS NOT NULL AND expense_id IS NULL AND refund_id IS NULL AND reversal_of_id IS NULL) OR (transaction_type='EXPENSE' AND direction='OUT' AND expense_id IS NOT NULL AND contribution_id IS NULL AND refund_id IS NULL AND reversal_of_id IS NULL) OR (transaction_type='REFUND' AND direction='OUT' AND refund_id IS NOT NULL AND contribution_id IS NULL AND expense_id IS NULL AND reversal_of_id IS NULL) OR (transaction_type='REVERSAL' AND reversal_of_id IS NOT NULL AND contribution_id IS NULL AND expense_id IS NULL AND refund_id IS NULL AND reason IS NOT NULL)),
  CONSTRAINT uq_fund_transactions_1 UNIQUE (business_key),
  CONSTRAINT uq_fund_transactions_2 UNIQUE (id, fund_id),
  CONSTRAINT uq_fund_transactions_3 UNIQUE (fund_id, sequence)
);

-- Một phiên đóng quỹ với snapshot bất biến.
CREATE TABLE finance_closures (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  status varchar(24) NOT NULL,
  snapshot_finance_version integer NOT NULL,
  snapshot_schema_version smallint NOT NULL,
  snapshot_json jsonb NOT NULL,
  snapshot_hash varchar(128) NOT NULL,
  requested_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  cancelled_reason text,
  closed_at timestamptz,
  CONSTRAINT pk_finance_closures PRIMARY KEY (id),
  CONSTRAINT ck_finance_closures_1 CHECK (snapshot_schema_version > 0),
  CONSTRAINT ck_finance_closures_2 CHECK (status IN ('PENDING_CONFIRMATIONS','CANCELLED','COMPLETED'))
);

-- Tập thành viên bắt buộc và xác nhận theo đúng phiên closure.
CREATE TABLE closure_confirmations (
  closure_id uuid NOT NULL,
  user_id uuid NOT NULL,
  snapshot_hash varchar(128) NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_closure_confirmations PRIMARY KEY (closure_id, user_id)
);

-- Một cấu trúc chung cho idempotency client và operation result liên-service.
CREATE TABLE command_receipts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  operation_id uuid,
  actor_user_id uuid,
  command_scope varchar(60) NOT NULL,
  idempotency_key varchar(120) NOT NULL,
  request_hash varchar(128) NOT NULL,
  status varchar(16) NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  system_actor varchar(60),
  CONSTRAINT pk_command_receipts PRIMARY KEY (id),
  CONSTRAINT ck_command_receipts_1 CHECK (status IN ('PROCESSING','COMMITTED','REJECTED','CANCELLED')),
  CONSTRAINT ck_command_receipts_2 CHECK ((actor_user_id IS NULL) <> (system_actor IS NULL)),
  CONSTRAINT uq_command_receipts_1 UNIQUE (operation_id)
);

-- Cấu hình MoMo Sandbox/VietQR không bí mật do Finance sở hữu.
CREATE TABLE payment_provider_configs (
  provider varchar(30) NOT NULL,
  environment varchar(16) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  updated_by_user_id uuid,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_payment_provider_configs PRIMARY KEY (provider, environment),
  CONSTRAINT ck_payment_provider_configs_1 CHECK (version > 0)
);

-- Phát Fund/Contribution/FinanceClosed sau commit.
CREATE TABLE outbox_events (
  event_id uuid NOT NULL,
  event_type varchar(100) NOT NULL,
  schema_version smallint NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  correlation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  aggregate_type varchar(40) NOT NULL,
  producer varchar(40) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  causation_id uuid,
  operation_id uuid,
  trip_id uuid,
  actor_user_id uuid,
  system_actor varchar(60),
  claim_owner varchar(100),
  claim_until timestamptz,
  CONSTRAINT pk_outbox_events PRIMARY KEY (event_id),
  CONSTRAINT ck_outbox_events_1 CHECK (status IN ('PENDING','PUBLISHED','FAILED')),
  CONSTRAINT ck_outbox_events_2 CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT ck_outbox_events_3 CHECK ((actor_user_id IS NULL) <> (system_actor IS NULL)),
  CONSTRAINT ck_outbox_events_4 CHECK (schema_version > 0),
  CONSTRAINT ck_outbox_events_5 CHECK (aggregate_version > 0),
  CONSTRAINT ck_outbox_events_6 CHECK (attempt_count >= 0)
);

-- Dấu vết nghiệp vụ Finance và truy cập hỗ trợ; ghi cùng transaction thay đổi.
CREATE TABLE finance_audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  actor_user_id uuid,
  action varchar(60) NOT NULL,
  entity_type varchar(40) NOT NULL,
  entity_id uuid,
  from_version integer,
  to_version integer,
  reason text,
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  correlation_id uuid NOT NULL,
  system_actor varchar(60),
  CONSTRAINT pk_finance_audit_logs PRIMARY KEY (id)
);
COMMENT ON COLUMN funds.trip_id IS 'Logical reference to Trip.trips; no cross-service FK';
COMMENT ON COLUMN funds.holder_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE payment_destinations ADD CONSTRAINT fk_payment_destinations_1 FOREIGN KEY (fund_id) REFERENCES funds (id) ON DELETE NO ACTION;
CREATE UNIQUE INDEX uq_payment_destinations_1 ON payment_destinations (fund_id, destination_type) WHERE is_default AND active;
ALTER TABLE contribution_requests ADD CONSTRAINT fk_contribution_requests_1 FOREIGN KEY (fund_id) REFERENCES funds (id) ON DELETE NO ACTION;
COMMENT ON COLUMN contribution_requests.created_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE contributions ADD CONSTRAINT fk_contributions_1 FOREIGN KEY (fund_id) REFERENCES funds (id) ON DELETE NO ACTION;
ALTER TABLE contributions ADD CONSTRAINT fk_contributions_2 FOREIGN KEY (request_id, fund_id) REFERENCES contribution_requests (id, fund_id) ON DELETE NO ACTION;
COMMENT ON COLUMN contributions.member_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN contributions.confirmed_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE payment_attempts ADD CONSTRAINT fk_payment_attempts_1 FOREIGN KEY (contribution_id) REFERENCES contributions (id) ON DELETE NO ACTION;
CREATE UNIQUE INDEX uq_payment_attempts_3 ON payment_attempts (provider, environment, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX uq_payment_attempts_4 ON payment_attempts (contribution_id) WHERE status IN ('CREATED','PENDING') OR needs_reconciliation;
CREATE INDEX ix_payment_attempts_1 ON payment_attempts (status, updated_at);
ALTER TABLE payment_webhook_receipts ADD CONSTRAINT fk_payment_webhook_receipts_1 FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts (id) ON DELETE NO ACTION;
CREATE INDEX ix_payment_webhook_receipts_1 ON payment_webhook_receipts (processing_status, received_at);
COMMENT ON COLUMN payment_webhook_receipts.reviewed_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE fund_expenses ADD CONSTRAINT fk_fund_expenses_1 FOREIGN KEY (fund_id) REFERENCES funds (id) ON DELETE NO ACTION;
COMMENT ON COLUMN fund_expenses.created_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN fund_expenses.confirmed_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN fund_expenses.paid_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE financial_notes ADD CONSTRAINT fk_financial_notes_1 FOREIGN KEY (fund_id) REFERENCES funds (id) ON DELETE NO ACTION;
COMMENT ON COLUMN financial_notes.payer_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN financial_notes.created_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE fund_refunds ADD CONSTRAINT fk_fund_refunds_1 FOREIGN KEY (fund_id) REFERENCES funds (id) ON DELETE NO ACTION;
COMMENT ON COLUMN fund_refunds.member_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN fund_refunds.requested_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN fund_refunds.confirmed_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE fund_transactions ADD CONSTRAINT fk_fund_transactions_1 FOREIGN KEY (fund_id) REFERENCES funds (id) ON DELETE NO ACTION;
ALTER TABLE fund_transactions ADD CONSTRAINT fk_fund_transactions_2 FOREIGN KEY (contribution_id, fund_id) REFERENCES contributions (id, fund_id) ON DELETE NO ACTION;
ALTER TABLE fund_transactions ADD CONSTRAINT fk_fund_transactions_3 FOREIGN KEY (expense_id, fund_id) REFERENCES fund_expenses (id, fund_id) ON DELETE NO ACTION;
ALTER TABLE fund_transactions ADD CONSTRAINT fk_fund_transactions_4 FOREIGN KEY (refund_id, fund_id) REFERENCES fund_refunds (id, fund_id) ON DELETE NO ACTION;
ALTER TABLE fund_transactions ADD CONSTRAINT fk_fund_transactions_5 FOREIGN KEY (reversal_of_id, fund_id) REFERENCES fund_transactions (id, fund_id) ON DELETE NO ACTION;
CREATE UNIQUE INDEX uq_fund_transactions_4 ON fund_transactions (contribution_id) WHERE contribution_id IS NOT NULL;
CREATE UNIQUE INDEX uq_fund_transactions_5 ON fund_transactions (expense_id) WHERE expense_id IS NOT NULL;
CREATE UNIQUE INDEX uq_fund_transactions_6 ON fund_transactions (refund_id) WHERE refund_id IS NOT NULL;
CREATE UNIQUE INDEX uq_fund_transactions_7 ON fund_transactions (reversal_of_id) WHERE reversal_of_id IS NOT NULL;
COMMENT ON COLUMN fund_transactions.actor_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE finance_closures ADD CONSTRAINT fk_finance_closures_1 FOREIGN KEY (fund_id) REFERENCES funds (id) ON DELETE NO ACTION;
CREATE UNIQUE INDEX uq_finance_closures_1 ON finance_closures (fund_id) WHERE status='PENDING_CONFIRMATIONS';
CREATE UNIQUE INDEX uq_finance_closures_2 ON finance_closures (fund_id) WHERE status='COMPLETED';
COMMENT ON COLUMN finance_closures.requested_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE closure_confirmations ADD CONSTRAINT fk_closure_confirmations_1 FOREIGN KEY (closure_id) REFERENCES finance_closures (id) ON DELETE NO ACTION;
COMMENT ON COLUMN closure_confirmations.user_id IS 'Logical reference to Identity.users; no cross-service FK';
CREATE UNIQUE INDEX uq_command_receipts_2 ON command_receipts (actor_user_id, command_scope, idempotency_key) WHERE actor_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_command_receipts_3 ON command_receipts (system_actor, command_scope, idempotency_key) WHERE system_actor IS NOT NULL;
COMMENT ON COLUMN command_receipts.actor_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN payment_provider_configs.updated_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
CREATE INDEX ix_outbox_events_1 ON outbox_events (next_attempt_at) WHERE status = 'PENDING';
COMMENT ON COLUMN outbox_events.actor_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE finance_audit_logs ADD CONSTRAINT fk_finance_audit_logs_1 FOREIGN KEY (fund_id) REFERENCES funds (id) ON DELETE NO ACTION;
COMMENT ON COLUMN finance_audit_logs.actor_user_id IS 'Logical reference to Identity.users; no cross-service FK';
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Ledger is append-only; use a reversal'; END $$;
CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON fund_transactions FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
INSERT INTO schema_migrations(version) VALUES ('V001');
COMMIT;
