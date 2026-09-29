-- Wolfari travel_db | V001 | schema baseline 1.1
-- Run once on an empty database using its owner. No cross-database SQL.
BEGIN;
DO $$ BEGIN IF current_database() <> 'travel_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO travel_app;
SET LOCAL search_path = public;
CREATE TABLE schema_migrations (version varchar(30) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- Cache tái tạo được cho place/route/weather.
CREATE TABLE provider_cache (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider varchar(50) NOT NULL,
  data_type varchar(30) NOT NULL,
  canonical_key varchar(128) NOT NULL,
  payload jsonb,
  status varchar(16) NOT NULL,
  error_code varchar(60),
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_provider_cache PRIMARY KEY (id),
  CONSTRAINT ck_provider_cache_1 CHECK (status IN ('SUCCESS','NO_RESULT','ERROR')),
  CONSTRAINT ck_provider_cache_2 CHECK (expires_at > fetched_at),
  CONSTRAINT uq_provider_cache_1 UNIQUE (provider, data_type, canonical_key)
);

-- Cấu hình provider không bí mật có thể chỉnh bởi Admin.
CREATE TABLE provider_configs (
  provider varchar(50) NOT NULL,
  module varchar(30) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  updated_by_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT pk_provider_configs PRIMARY KEY (provider, module),
  CONSTRAINT ck_provider_configs_1 CHECK (version > 0)
);

-- Danh mục tiện ích công cộng như ATM/y tế do Travel sở hữu.
CREATE TABLE public_amenity_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code varchar(60) NOT NULL,
  name varchar(120) NOT NULL,
  amenity_type varchar(40) NOT NULL,
  provider_mappings jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT pk_public_amenity_categories PRIMARY KEY (id),
  CONSTRAINT ck_public_amenity_categories_1 CHECK (version > 0),
  CONSTRAINT uq_public_amenity_categories_1 UNIQUE (code)
);
CREATE INDEX ix_provider_cache_1 ON provider_cache (expires_at);
COMMENT ON COLUMN provider_configs.updated_by_user_id IS 'Logical reference to Identity.users; no cross-service FK';
INSERT INTO schema_migrations(version) VALUES ('V001');
COMMIT;
