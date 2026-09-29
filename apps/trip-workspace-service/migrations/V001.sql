-- Wolfari trip_db | V001 | schema baseline 1.1
-- Run once on an empty database using its owner. No cross-database SQL.
BEGIN;
DO $$ BEGIN IF current_database() <> 'trip_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO trip_app;
SET LOCAL search_path = public;
CREATE TABLE schema_migrations (version varchar(30) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- Aggregate root của workspace và Plan.
CREATE TABLE trips (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  description text,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  timezone varchar(64) NOT NULL,
  plan_edit_policy varchar(24) NOT NULL DEFAULT 'OWNER_ONLY',
  source_template_id uuid,
  source_template_version integer,
  created_by_user_id uuid NOT NULL,
  plan_version integer NOT NULL DEFAULT 1,
  membership_revision integer NOT NULL DEFAULT 1,
  export_revision integer NOT NULL DEFAULT 1,
  closure_lock_id uuid,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  public_description text,
  CONSTRAINT pk_trips PRIMARY KEY (id),
  CONSTRAINT ck_trips_1 CHECK (plan_version > 0),
  CONSTRAINT ck_trips_2 CHECK (membership_revision > 0),
  CONSTRAINT ck_trips_3 CHECK (export_revision > 0),
  CONSTRAINT ck_trips_4 CHECK (end_at > start_at),
  CONSTRAINT ck_trips_5 CHECK (plan_edit_policy IN ('OWNER_ONLY','SELECTED_MEMBERS','ALL_MEMBERS'))
);

-- Template Plan đóng gói cho weekend/biển/núi/city tour; không tạo membership/Finance.
CREATE TABLE trip_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code varchar(60) NOT NULL,
  name varchar(150) NOT NULL,
  description text,
  category varchar(40) NOT NULL,
  plan_blueprint jsonb NOT NULL,
  schema_version smallint NOT NULL,
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_trip_templates PRIMARY KEY (id),
  CONSTRAINT ck_trip_templates_1 CHECK (schema_version > 0),
  CONSTRAINT ck_trip_templates_2 CHECK (version > 0),
  CONSTRAINT uq_trip_templates_1 UNIQUE (code)
);

-- Lịch sử membership, vai trò Owner/Member và thời điểm rời.
CREATE TABLE trip_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role varchar(16) NOT NULL,
  joined_at timestamptz NOT NULL,
  left_at timestamptz,
  left_reason varchar(40),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_trip_members PRIMARY KEY (id),
  CONSTRAINT ck_trip_members_1 CHECK (role IN ('OWNER','MEMBER')),
  CONSTRAINT uq_trip_members_1 UNIQUE (id, trip_id)
);

-- Lời mời tham gia Trip có vòng đời đầy đủ.
CREATE TABLE invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  email varchar(255),
  invited_by_user_id uuid NOT NULL,
  token_hash varchar(128) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  resolved_by_user_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  invitation_type varchar(10) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  delivery_token_ciphertext text,
  delivery_token_expires_at timestamptz,
  CONSTRAINT pk_invitations PRIMARY KEY (id),
  CONSTRAINT ck_invitations_1 CHECK (version > 0),
  CONSTRAINT ck_invitations_2 CHECK (status IN ('PENDING','ACCEPTED','DECLINED','REVOKED','EXPIRED')),
  CONSTRAINT ck_invitations_3 CHECK (invitation_type IN ('EMAIL','LINK')),
  CONSTRAINT ck_invitations_4 CHECK ((invitation_type = 'EMAIL' AND email IS NOT NULL) OR (invitation_type = 'LINK' AND email IS NULL)),
  CONSTRAINT ck_invitations_5 CHECK (expires_at > created_at),
  CONSTRAINT uq_invitations_1 UNIQUE (token_hash)
);

-- Danh sách Member được chọn khi policy là SELECTED_MEMBERS.
CREATE TABLE trip_plan_editors (
  trip_id uuid NOT NULL,
  trip_member_id uuid NOT NULL,
  granted_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_trip_plan_editors PRIMARY KEY (trip_id, trip_member_id)
);

-- Địa điểm đã chọn; snapshot ổn định, không phụ thuộc cache Travel.
CREATE TABLE selected_locations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  provider varchar(40),
  provider_place_id varchar(255),
  name varchar(255) NOT NULL,
  address text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source varchar(20) NOT NULL DEFAULT 'MANUAL',
  opening_hours jsonb,
  fetched_at timestamptz,
  CONSTRAINT pk_selected_locations PRIMARY KEY (id),
  CONSTRAINT ck_selected_locations_1 CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CONSTRAINT ck_selected_locations_2 CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT ck_selected_locations_3 CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT ck_selected_locations_4 CHECK (source IN ('MANUAL','PROVIDER')),
  CONSTRAINT uq_selected_locations_1 UNIQUE (id, trip_id)
);

-- Hoạt động trong timeline.
CREATE TABLE activities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  selected_location_id uuid,
  title varchar(255) NOT NULL,
  description text,
  starts_at timestamptz,
  ends_at timestamptz,
  position integer NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'TODO',
  completed_by_user_id uuid,
  completed_at timestamptz,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source varchar(20) NOT NULL DEFAULT 'MANUAL',
  public_description text,
  activity_type varchar(40) NOT NULL DEFAULT 'OTHER',
  CONSTRAINT pk_activities PRIMARY KEY (id),
  CONSTRAINT ck_activities_1 CHECK ((starts_at IS NULL AND ends_at IS NULL) OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at)),
  CONSTRAINT ck_activities_2 CHECK (position >= 0),
  CONSTRAINT ck_activities_3 CHECK (status IN ('TODO','COMPLETED')),
  CONSTRAINT ck_activities_4 CHECK ((status='TODO' AND completed_at IS NULL AND completed_by_user_id IS NULL) OR (status='COMPLETED' AND completed_at IS NOT NULL AND completed_by_user_id IS NOT NULL)),
  CONSTRAINT ck_activities_5 CHECK (source IN ('MANUAL','DSS')),
  CONSTRAINT uq_activities_1 UNIQUE (id, trip_id),
  CONSTRAINT uq_activities_2 UNIQUE (trip_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- Quy định trang phục theo Trip, ngày hoặc activity.
CREATE TABLE dress_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  scope_type varchar(16) NOT NULL,
  plan_date date,
  activity_id uuid,
  label varchar(100) NOT NULL,
  description text,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source varchar(20) NOT NULL DEFAULT 'MANUAL',
  public_description text,
  CONSTRAINT pk_dress_codes PRIMARY KEY (id),
  CONSTRAINT ck_dress_codes_1 CHECK ((scope_type='TRIP' AND plan_date IS NULL AND activity_id IS NULL) OR (scope_type='DAY' AND plan_date IS NOT NULL AND activity_id IS NULL) OR (scope_type='ACTIVITY' AND plan_date IS NULL AND activity_id IS NOT NULL)),
  CONSTRAINT ck_dress_codes_2 CHECK (source IN ('MANUAL','DSS'))
);

-- Danh sách hành lý chung/cá nhân và completion.
CREATE TABLE packing_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  name varchar(200) NOT NULL,
  quantity numeric(10,2) NOT NULL DEFAULT 1,
  unit varchar(30),
  assigned_member_id uuid,
  source varchar(20) NOT NULL DEFAULT 'MANUAL',
  due_at timestamptz,
  status varchar(16) NOT NULL DEFAULT 'TODO',
  completed_by_user_id uuid,
  completed_at timestamptz,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  note text,
  category varchar(80),
  CONSTRAINT pk_packing_items PRIMARY KEY (id),
  CONSTRAINT ck_packing_items_1 CHECK (quantity > 0),
  CONSTRAINT ck_packing_items_2 CHECK (source IN ('MANUAL','DSS')),
  CONSTRAINT ck_packing_items_3 CHECK (status IN ('TODO','COMPLETED')),
  CONSTRAINT ck_packing_items_4 CHECK ((status='TODO' AND completed_at IS NULL AND completed_by_user_id IS NULL) OR (status='COMPLETED' AND completed_at IS NOT NULL AND completed_by_user_id IS NOT NULL))
);

-- Public share read-only với whitelist nhóm dữ liệu.
CREATE TABLE share_links (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  token_hash varchar(128) NOT NULL,
  password_hash text,
  show_timeline boolean NOT NULL DEFAULT true,
  show_locations boolean NOT NULL DEFAULT true,
  show_dress_code boolean NOT NULL DEFAULT true,
  show_packing boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_share_links PRIMARY KEY (id),
  CONSTRAINT ck_share_links_1 CHECK (expires_at > created_at),
  CONSTRAINT uq_share_links_1 UNIQUE (token_hash)
);

-- Kết quả preview/apply DSS và chống apply lặp.
CREATE TABLE recommendation_receipts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  rule_version varchar(40) NOT NULL,
  base_plan_version integer NOT NULL,
  proposal jsonb NOT NULL,
  apply_request_id uuid,
  status varchar(16) NOT NULL,
  applied_plan_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  input_hash varchar(128) NOT NULL,
  recommendation_type varchar(30) NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT pk_recommendation_receipts PRIMARY KEY (id),
  CONSTRAINT ck_recommendation_receipts_1 CHECK (status IN ('PREVIEWED','APPLIED','REJECTED','EXPIRED')),
  CONSTRAINT ck_recommendation_receipts_2 CHECK (expires_at > created_at),
  CONSTRAINT uq_recommendation_receipts_1 UNIQUE (apply_request_id)
);

-- Job và snapshot bất biến do Trip sở hữu; Worker không có DB riêng.
CREATE TABLE export_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  format varchar(16) NOT NULL,
  scope varchar(20) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PREPARING',
  export_preset_id uuid,
  export_preset_version integer,
  attempt_id uuid NOT NULL,
  snapshot_schema_version smallint NOT NULL,
  snapshot_captured_at timestamptz,
  snapshot_plan_version integer,
  snapshot_finance_version integer,
  snapshot_object_key text,
  snapshot_hash varchar(128),
  result_object_key text,
  error_code varchar(60),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  snapshot_export_revision integer,
  client_request_id uuid NOT NULL,
  request_hash varchar(128) NOT NULL,
  claim_owner varchar(100),
  claim_until timestamptz,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  completed_at timestamptz,
  CONSTRAINT pk_export_jobs PRIMARY KEY (id),
  CONSTRAINT ck_export_jobs_1 CHECK (snapshot_schema_version > 0),
  CONSTRAINT ck_export_jobs_2 CHECK (version > 0),
  CONSTRAINT ck_export_jobs_3 CHECK (status IN ('PREPARING','QUEUED','RUNNING','SUCCEEDED','FAILED','EXPIRED')),
  CONSTRAINT ck_export_jobs_4 CHECK (format IN ('XLSX','PDF','PNG')),
  CONSTRAINT ck_export_jobs_5 CHECK (scope IN ('PLAN','PLAN_FINANCE')),
  CONSTRAINT uq_export_jobs_1 UNIQUE (requested_by_user_id, client_request_id)
);

-- Metadata template export/theme infographic đóng gói, do Admin bật/tắt.
CREATE TABLE export_presets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code varchar(60) NOT NULL,
  name varchar(150) NOT NULL,
  preset_type varchar(20) NOT NULL,
  config jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_export_presets PRIMARY KEY (id),
  CONSTRAINT ck_export_presets_1 CHECK (version > 0),
  CONSTRAINT ck_export_presets_2 CHECK (preset_type IN ('EXCEL','PDF','INFOGRAPHIC')),
  CONSTRAINT uq_export_presets_1 UNIQUE (code)
);

-- Audit thay đổi/version và truy cập hỗ trợ vào Trip riêng tư.
CREATE TABLE trip_audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
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
  CONSTRAINT pk_trip_audit_logs PRIMARY KEY (id)
);

-- Guard/recovery cho archive, enable/close Finance và lệnh liên-service.
CREATE TABLE trip_operations (
  operation_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  operation_type varchar(40) NOT NULL,
  actor_user_id uuid,
  request_hash varchar(128) NOT NULL,
  state varchar(24) NOT NULL,
  context_revision integer NOT NULL,
  outcome jsonb,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  command_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  system_actor varchar(60),
  CONSTRAINT pk_trip_operations PRIMARY KEY (operation_id),
  CONSTRAINT ck_trip_operations_1 CHECK (retry_count >= 0),
  CONSTRAINT ck_trip_operations_2 CHECK (state IN ('PROCESSING','PENDING_RECOVERY','SUCCEEDED','FAILED','NEEDS_REVIEW'))
);

-- Phát sự kiện Trip/Plan/Membership và lệnh GenerateExport sau commit.
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

-- Dedupe event đến, đặc biệt ExportStarted/ExportCompleted/Failed.
CREATE TABLE inbox_events (
  consumer_name varchar(80) NOT NULL,
  event_id uuid NOT NULL,
  event_type varchar(100) NOT NULL,
  aggregate_version integer,
  processed_at timestamptz NOT NULL DEFAULT now(),
  result jsonb,
  CONSTRAINT pk_inbox_events PRIMARY KEY (consumer_name, event_id),
  CONSTRAINT ck_inbox_events_1 CHECK (aggregate_version > 0)
);
ALTER TABLE trips ADD CONSTRAINT fk_trips_1 FOREIGN KEY (source_template_id) REFERENCES trip_templates (id) ON DELETE NO ACTION;
COMMENT ON COLUMN trips.created_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN trips.closure_lock_id IS 'Logical reference to Finance; no cross-service FK';
ALTER TABLE trip_members ADD CONSTRAINT fk_trip_members_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
CREATE UNIQUE INDEX uq_trip_members_2 ON trip_members (trip_id, user_id) WHERE left_at IS NULL;
CREATE UNIQUE INDEX uq_trip_members_3 ON trip_members (trip_id) WHERE role = 'OWNER' AND left_at IS NULL;
CREATE INDEX ix_trip_members_1 ON trip_members (user_id, left_at);
COMMENT ON COLUMN trip_members.user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE invitations ADD CONSTRAINT fk_invitations_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
CREATE INDEX ix_invitations_1 ON invitations (trip_id, status);
COMMENT ON COLUMN invitations.invited_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN invitations.resolved_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE trip_plan_editors ADD CONSTRAINT fk_trip_plan_editors_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
ALTER TABLE trip_plan_editors ADD CONSTRAINT fk_trip_plan_editors_2 FOREIGN KEY (trip_member_id, trip_id) REFERENCES trip_members (id, trip_id) ON DELETE NO ACTION;
COMMENT ON COLUMN trip_plan_editors.granted_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE selected_locations ADD CONSTRAINT fk_selected_locations_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
CREATE UNIQUE INDEX uq_selected_locations_2 ON selected_locations (trip_id, provider, provider_place_id) WHERE provider IS NOT NULL AND provider_place_id IS NOT NULL;
CREATE INDEX ix_selected_locations_1 ON selected_locations (trip_id);
COMMENT ON COLUMN selected_locations.created_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE activities ADD CONSTRAINT fk_activities_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
ALTER TABLE activities ADD CONSTRAINT fk_activities_2 FOREIGN KEY (selected_location_id, trip_id) REFERENCES selected_locations (id, trip_id) ON DELETE NO ACTION;
CREATE INDEX ix_activities_1 ON activities (trip_id);
COMMENT ON COLUMN activities.completed_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN activities.created_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE dress_codes ADD CONSTRAINT fk_dress_codes_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
ALTER TABLE dress_codes ADD CONSTRAINT fk_dress_codes_2 FOREIGN KEY (activity_id, trip_id) REFERENCES activities (id, trip_id) ON DELETE NO ACTION;
COMMENT ON COLUMN dress_codes.created_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE packing_items ADD CONSTRAINT fk_packing_items_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
ALTER TABLE packing_items ADD CONSTRAINT fk_packing_items_2 FOREIGN KEY (assigned_member_id, trip_id) REFERENCES trip_members (id, trip_id) ON DELETE NO ACTION;
COMMENT ON COLUMN packing_items.completed_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN packing_items.created_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE share_links ADD CONSTRAINT fk_share_links_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
COMMENT ON COLUMN share_links.created_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE recommendation_receipts ADD CONSTRAINT fk_recommendation_receipts_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
COMMENT ON COLUMN recommendation_receipts.requested_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE export_jobs ADD CONSTRAINT fk_export_jobs_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
ALTER TABLE export_jobs ADD CONSTRAINT fk_export_jobs_2 FOREIGN KEY (export_preset_id) REFERENCES export_presets (id) ON DELETE NO ACTION;
CREATE INDEX ix_export_jobs_1 ON export_jobs (status, created_at);
COMMENT ON COLUMN export_jobs.requested_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
COMMENT ON COLUMN export_presets.updated_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE trip_audit_logs ADD CONSTRAINT fk_trip_audit_logs_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
COMMENT ON COLUMN trip_audit_logs.actor_user_id IS 'Logical reference to Identity.users; no cross-service FK';
ALTER TABLE trip_operations ADD CONSTRAINT fk_trip_operations_1 FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE NO ACTION;
CREATE UNIQUE INDEX uq_trip_operations_1 ON trip_operations (trip_id) WHERE state IN ('PROCESSING','PENDING_RECOVERY','NEEDS_REVIEW');
CREATE INDEX ix_trip_operations_1 ON trip_operations (state, next_retry_at);
COMMENT ON COLUMN trip_operations.actor_user_id IS 'Logical reference to Identity.users; no cross-service FK';
CREATE INDEX ix_outbox_events_1 ON outbox_events (next_attempt_at) WHERE status = 'PENDING';
COMMENT ON COLUMN outbox_events.actor_user_id IS 'Logical reference to Identity.users; no cross-service FK';
INSERT INTO schema_migrations(version) VALUES ('V001');
COMMIT;
