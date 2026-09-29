-- Wolfari identity_db | V001 | schema baseline 1.1
-- Run once on an empty database using its owner. No cross-database SQL.
BEGIN;
DO $$ BEGIN IF current_database() <> 'identity_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO identity_app;
SET LOCAL search_path = public;
CREATE TABLE schema_migrations (version varchar(30) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- Tài khoản và hồ sơ tối thiểu dùng chung qua Identity API.
CREATE TABLE users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email varchar(255) NOT NULL,
  full_name varchar(150) NOT NULL,
  avatar_object_key text,
  system_role varchar(20) NOT NULL DEFAULT 'USER',
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  email_verified_at timestamptz,
  deletion_requested_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT pk_users PRIMARY KEY (id),
  CONSTRAINT ck_users_1 CHECK (version > 0),
  CONSTRAINT ck_users_2 CHECK (system_role IN ('USER','ADMIN')),
  CONSTRAINT ck_users_3 CHECK (status IN ('ACTIVE','LOCKED','DELETION_PENDING','ANONYMIZED'))
);

-- Mật khẩu local; OAuth-only user có thể không có row.
CREATE TABLE credentials (
  user_id uuid NOT NULL,
  password_hash text NOT NULL,
  password_changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_credentials PRIMARY KEY (user_id)
);

-- Liên kết tài khoản OAuth với user nội bộ.
CREATE TABLE oauth_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider varchar(30) NOT NULL,
  provider_user_id varchar(255) NOT NULL,
  provider_email varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_oauth_accounts PRIMARY KEY (id),
  CONSTRAINT uq_oauth_accounts_1 UNIQUE (provider, provider_user_id),
  CONSTRAINT uq_oauth_accounts_2 UNIQUE (user_id, provider)
);

-- Refresh-token rotation theo session/family; chỉ lưu hash.
CREATE TABLE refresh_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  family_id uuid NOT NULL,
  token_hash varchar(128) NOT NULL,
  replaced_by_session_id uuid,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT pk_refresh_sessions PRIMARY KEY (id),
  CONSTRAINT ck_refresh_sessions_1 CHECK (expires_at > created_at),
  CONSTRAINT uq_refresh_sessions_1 UNIQUE (token_hash)
);

-- Token dùng một lần cho xác minh email/khôi phục mật khẩu.
CREATE TABLE one_time_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  purpose varchar(30) NOT NULL,
  token_hash varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  requested_email varchar(255),
  delivery_token_ciphertext text,
  delivery_token_expires_at timestamptz,
  CONSTRAINT pk_one_time_tokens PRIMARY KEY (id),
  CONSTRAINT ck_one_time_tokens_1 CHECK (expires_at > created_at),
  CONSTRAINT ck_one_time_tokens_2 CHECK (purpose IN ('VERIFY_EMAIL','RESET_PASSWORD')),
  CONSTRAINT uq_one_time_tokens_1 UNIQUE (token_hash)
);

-- Dấu vết thao tác quản trị nhạy cảm và lý do truy cập.
CREATE TABLE admin_audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_user_id uuid,
  action varchar(80) NOT NULL,
  target_type varchar(50) NOT NULL,
  target_id varchar(100) NOT NULL,
  reason text NOT NULL,
  correlation_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  system_actor varchar(60),
  CONSTRAINT pk_admin_audit_logs PRIMARY KEY (id)
);

-- Phát AccountStatusChanged và sự kiện Identity sau khi commit.
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
CREATE UNIQUE INDEX uq_users_1 ON users (lower(email));
ALTER TABLE credentials ADD CONSTRAINT fk_credentials_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;
ALTER TABLE oauth_accounts ADD CONSTRAINT fk_oauth_accounts_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;
ALTER TABLE refresh_sessions ADD CONSTRAINT fk_refresh_sessions_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;
ALTER TABLE refresh_sessions ADD CONSTRAINT fk_refresh_sessions_2 FOREIGN KEY (replaced_by_session_id) REFERENCES refresh_sessions (id) ON DELETE NO ACTION;
CREATE INDEX ix_refresh_sessions_1 ON refresh_sessions (user_id, expires_at);
CREATE INDEX ix_refresh_sessions_2 ON refresh_sessions (family_id);
ALTER TABLE one_time_tokens ADD CONSTRAINT fk_one_time_tokens_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;
CREATE INDEX ix_one_time_tokens_1 ON one_time_tokens (user_id, expires_at);
ALTER TABLE admin_audit_logs ADD CONSTRAINT fk_admin_audit_logs_1 FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE NO ACTION;
CREATE INDEX ix_outbox_events_1 ON outbox_events (next_attempt_at) WHERE status = 'PENDING';
COMMENT ON COLUMN outbox_events.actor_user_id IS 'Logical reference to Identity.users; no cross-service FK';
INSERT INTO schema_migrations(version) VALUES ('V001');
COMMIT;
