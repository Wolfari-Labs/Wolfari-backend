-- Wolfari travel_db | V003 | MAP-POI: curated POI snapshots (golden list, later Overture).
-- pg_trgm and unaccent are trusted extensions (PostgreSQL 13+), so the database owner may create them.
BEGIN;
DO $$ BEGIN IF current_database() <> 'travel_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- One active snapshot at a time; loaders insert a new snapshot and flip is_active atomically.
CREATE TABLE poi_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version varchar(40) NOT NULL UNIQUE,
  manifest jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_poi_snapshots_active ON poi_snapshots (is_active) WHERE is_active;

CREATE TABLE pois (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES poi_snapshots(id) ON DELETE CASCADE,
  wolfari_key varchar(120) NOT NULL,
  tier smallint NOT NULL CHECK (tier IN (1,2,3,9)),
  name_vi varchar(255) NOT NULL, name_en varchar(255),
  aliases text[] NOT NULL DEFAULT '{}',
  search_text text NOT NULL,
  category varchar(40) NOT NULL, tags text[] NOT NULL DEFAULT '{}',
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  coord_verified boolean NOT NULL DEFAULT false,
  province_code varchar(10), address text,
  opening_hours text, hours_verified boolean NOT NULL DEFAULT false,
  typical_duration_min integer CHECK (typical_duration_min > 0),
  indoor boolean, dress_code_hint varchar(120), activity_type varchar(40),
  ticket_vnd_min bigint, ticket_vnd_max bigint,
  confidence numeric(4,3) NOT NULL, popularity numeric(6,3) NOT NULL DEFAULT 0,
  license varchar(40) NOT NULL, attribution text,
  UNIQUE (snapshot_id, wolfari_key)
);
CREATE INDEX ix_pois_bbox ON pois (snapshot_id, latitude, longitude);
CREATE INDEX ix_pois_search ON pois USING gin (search_text gin_trgm_ops);

CREATE TABLE poi_sources (
  poi_id uuid NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  source varchar(20) NOT NULL, source_id varchar(255) NOT NULL,
  license varchar(40) NOT NULL, fetched_at timestamptz NOT NULL,
  PRIMARY KEY (poi_id, source, source_id)
);

INSERT INTO schema_migrations(version) VALUES ('V003');
COMMIT;
