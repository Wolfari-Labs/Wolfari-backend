-- Wolfari automation_db | V001 | schema baseline 1.1
-- Run once on an empty database using its owner. No cross-database SQL.
BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO automation_app;
SET LOCAL search_path = public;
CREATE TABLE schema_migrations (version varchar(30) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- Thiết bị push của user.
CREATE TABLE device_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  platform varchar(20) NOT NULL,
  token text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_device_tokens PRIMARY KEY (id),
  CONSTRAINT ck_device_tokens_1 CHECK (platform IN ('IOS','ANDROID','WEB')),
  CONSTRAINT uq_device_tokens_1 UNIQUE (token)
);

-- Thiết lập kênh thông báo tối thiểu theo user.
CREATE TABLE notification_preferences (
  user_id uuid NOT NULL,
  push_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  group_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT pk_notification_preferences PRIMARY KEY (user_id),
  CONSTRAINT ck_notification_preferences_1 CHECK (version > 0)
);

-- Hộp thông báo in-app và nội dung nghiệp vụ an toàn.
CREATE TABLE notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  trip_id uuid,
  type varchar(60) NOT NULL,
  title varchar(255) NOT NULL,
  body text NOT NULL,
  source_id varchar(100),
  event_id uuid,
  status varchar(16) NOT NULL DEFAULT 'CREATED',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  recipient_email varchar(255),
  dedupe_key varchar(180) NOT NULL,
  CONSTRAINT pk_notifications PRIMARY KEY (id),
  CONSTRAINT ck_notifications_1 CHECK (status IN ('CREATED','AVAILABLE','CANCELLED')),
  CONSTRAINT ck_notifications_2 CHECK (user_id IS NOT NULL OR recipient_email IS NOT NULL),
  CONSTRAINT uq_notifications_1 UNIQUE (dedupe_key)
);

-- Theo dõi riêng từng kênh gửi và retry hữu hạn.
CREATE TABLE notification_deliveries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL,
  channel varchar(16) NOT NULL,
  delivery_key varchar(180) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  provider_reference varchar(180),
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  claim_owner varchar(100),
  claim_until timestamptz,
  private_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT pk_notification_deliveries PRIMARY KEY (id),
  CONSTRAINT ck_notification_deliveries_1 CHECK (attempt_count >= 0),
  CONSTRAINT ck_notification_deliveries_2 CHECK (channel IN ('PUSH','EMAIL')),
  CONSTRAINT ck_notification_deliveries_3 CHECK (status IN ('PENDING','SENDING','SENT','FAILED')),
  CONSTRAINT uq_notification_deliveries_1 UNIQUE (delivery_key)
);

-- Nhắc việc theo nguồn/version, có claim lease ngay trên row.
CREATE TABLE reminders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  type varchar(50) NOT NULL,
  source_id varchar(100) NOT NULL,
  source_revision integer NOT NULL,
  occurrence_key varchar(100) NOT NULL,
  remind_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  claim_owner varchar(100),
  claim_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_reminders PRIMARY KEY (id),
  CONSTRAINT ck_reminders_1 CHECK (attempt_count >= 0),
  CONSTRAINT ck_reminders_2 CHECK (status IN ('PENDING','PROCESSING','SENT','CANCELLED','FAILED')),
  CONSTRAINT uq_reminders_1 UNIQUE (user_id, type, source_id, source_revision, occurrence_key)
);

-- Gom các watch có đầy đủ tham số tìm kiếm giống nhau.
CREATE TABLE price_query_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider varchar(50) NOT NULL,
  transport_type varchar(30) NOT NULL,
  canonical_key varchar(128) NOT NULL,
  origin varchar(120) NOT NULL,
  destination varchar(120) NOT NULL,
  departure_date date NOT NULL,
  return_date date,
  passenger_count smallint NOT NULL,
  cabin_class varchar(30),
  currency char(3) NOT NULL DEFAULT 'VND',
  params jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  next_check_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_price_query_groups PRIMARY KEY (id),
  CONSTRAINT ck_price_query_groups_1 CHECK (passenger_count > 0),
  CONSTRAINT ck_price_query_groups_2 CHECK (return_date >= departure_date),
  CONSTRAINT ck_price_query_groups_3 CHECK (currency='VND'),
  CONSTRAINT uq_price_query_groups_1 UNIQUE (canonical_key)
);

-- Một lần chạy có scheduled slot, lease và kết quả.
CREATE TABLE price_query_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  query_group_id uuid NOT NULL,
  scheduled_slot timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  claim_owner varchar(100),
  claim_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_code varchar(60),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_price_query_attempts PRIMARY KEY (id),
  CONSTRAINT ck_price_query_attempts_1 CHECK (attempt_count >= 0),
  CONSTRAINT ck_price_query_attempts_2 CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','NO_RESULT','FAILED')),
  CONSTRAINT uq_price_query_attempts_1 UNIQUE (query_group_id, scheduled_slot),
  CONSTRAINT uq_price_query_attempts_2 UNIQUE (id, query_group_id)
);

-- Theo dõi giá riêng theo user và Trip dù dùng chung query group.
CREATE TABLE price_watches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  query_group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  threshold_price bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'VND',
  status varchar(16) NOT NULL DEFAULT 'ACTIVE',
  status_reason varchar(40),
  version integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  last_alert_price bigint,
  last_alert_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  alert_armed boolean NOT NULL DEFAULT true,
  client_request_id uuid NOT NULL,
  request_hash varchar(128) NOT NULL,
  CONSTRAINT pk_price_watches PRIMARY KEY (id),
  CONSTRAINT ck_price_watches_1 CHECK (version > 0),
  CONSTRAINT ck_price_watches_2 CHECK (status IN ('ACTIVE','PAUSED','EXPIRED','STOPPED')),
  CONSTRAINT ck_price_watches_3 CHECK (threshold_price > 0),
  CONSTRAINT ck_price_watches_4 CHECK (currency='VND'),
  CONSTRAINT uq_price_watches_1 UNIQUE (user_id, client_request_id)
);

-- Giá quan sát được; không ghi giá 0 cho lỗi/no-result.
CREATE TABLE price_observations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  query_group_id uuid NOT NULL,
  query_attempt_id uuid NOT NULL,
  price bigint NOT NULL,
  currency char(3) NOT NULL,
  provider varchar(50) NOT NULL,
  fare_metadata jsonb NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL,
  CONSTRAINT pk_price_observations PRIMARY KEY (id),
  CONSTRAINT ck_price_observations_1 CHECK (price > 0),
  CONSTRAINT ck_price_observations_2 CHECK (currency='VND')
);

-- Dedupe và áp dụng idempotent event Trip/Identity/Finance.
CREATE TABLE inbox_events (
  consumer_name varchar(80) NOT NULL,
  event_id uuid NOT NULL,
  event_type varchar(100) NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer,
  processed_at timestamptz NOT NULL DEFAULT now(),
  result jsonb,
  CONSTRAINT pk_inbox_events PRIMARY KEY (consumer_name, event_id),
  CONSTRAINT ck_inbox_events_1 CHECK (aggregate_version > 0)
);

-- Cấu hình không bí mật cho price, push/email và lịch chạy.
CREATE TABLE automation_configs (
  module varchar(30) NOT NULL,
  config_key varchar(60) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  updated_by_user_id uuid,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_automation_configs PRIMARY KEY (module, config_key),
  CONSTRAINT ck_automation_configs_1 CHECK (version > 0),
  CONSTRAINT ck_automation_configs_2 CHECK (module IN ('PRICE','PUSH','EMAIL','SCHEDULER'))
);
COMMENT ON COLUMN device_tokens.user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN notification_preferences.user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN notifications.user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN notifications.trip_id IS 'Logical reference to Trip.trips; no cross-service FK';
ALTER TABLE notification_deliveries ADD CONSTRAINT fk_notification_deliveries_1 FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE NO ACTION;
CREATE INDEX ix_notification_deliveries_1 ON notification_deliveries (status, next_attempt_at);
CREATE INDEX ix_reminders_1 ON reminders (status, remind_at);
COMMENT ON COLUMN reminders.user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN reminders.trip_id IS 'Logical reference to Trip.trips; no cross-service FK';
CREATE INDEX ix_price_query_groups_1 ON price_query_groups (active, next_check_at);
ALTER TABLE price_query_attempts ADD CONSTRAINT fk_price_query_attempts_1 FOREIGN KEY (query_group_id) REFERENCES price_query_groups (id) ON DELETE NO ACTION;
ALTER TABLE price_watches ADD CONSTRAINT fk_price_watches_1 FOREIGN KEY (query_group_id) REFERENCES price_query_groups (id) ON DELETE NO ACTION;
CREATE INDEX ix_price_watches_1 ON price_watches (trip_id, status);
COMMENT ON COLUMN price_watches.user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN price_watches.trip_id IS 'Logical reference to Trip.trips; no cross-service FK';
ALTER TABLE price_observations ADD CONSTRAINT fk_price_observations_1 FOREIGN KEY (query_group_id) REFERENCES price_query_groups (id) ON DELETE NO ACTION;
ALTER TABLE price_observations ADD CONSTRAINT fk_price_observations_2 FOREIGN KEY (query_attempt_id, query_group_id) REFERENCES price_query_attempts (id, query_group_id) ON DELETE NO ACTION;
CREATE INDEX ix_price_observations_1 ON price_observations (query_group_id, observed_at DESC);
COMMENT ON COLUMN automation_configs.updated_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
INSERT INTO schema_migrations(version) VALUES ('V001');
COMMIT;
