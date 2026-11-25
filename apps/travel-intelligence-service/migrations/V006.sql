-- Wolfari travel_db | V006 | POI-IMAGES: licensed photos per POI, kept outside POI snapshots.
-- Additive only. Media are keyed by stable identifiers (Overture GERS id or golden wolfari_key),
-- never by pois.id, so reloading a snapshot keeps them. A batch is switched on/off as a whole.
BEGIN;
DO $$ BEGIN IF current_database() <> 'travel_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;

-- One active media batch at a time; rolling back = activating the previous batch.
CREATE TABLE poi_media_batches (
  id varchar(40) PRIMARY KEY,
  manifest jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_poi_media_batches_active ON poi_media_batches (is_active) WHERE is_active;

CREATE TABLE poi_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gers_id varchar(40),                    -- Overture GERS id (no "ov-" prefix)
  golden_key varchar(120),                -- golden wolfari_key (dn-...)
  role varchar(10) NOT NULL CHECK (role IN ('hero', 'gallery')),
  rank smallint NOT NULL DEFAULT 0,
  source varchar(20) NOT NULL,            -- manual|wikidata|wikipedia|commons_category|commons_geo|osm_tag
  source_url text NOT NULL,
  original_url text,
  storage_key text NOT NULL,              -- object prefix; variants are <prefix>/<width>.webp
  width int, height int, bytes int, mime varchar(40),
  sha256 char(64) NOT NULL,
  phash bigint,
  blurhash varchar(40),
  license_code varchar(40) NOT NULL,
  license_url text,
  author text,
  attribution text NOT NULL,
  match_method varchar(30),
  match_score numeric(4,3), quality_score numeric(4,3), final_score numeric(4,3),
  inherited boolean NOT NULL DEFAULT false,
  status varchar(12) NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'rejected', 'takedown')),
  batch_id varchar(40) NOT NULL REFERENCES poi_media_batches(id) ON DELETE CASCADE,
  fetched_at timestamptz NOT NULL,
  revalidated_at timestamptz,
  CHECK ((gers_id IS NULL) <> (golden_key IS NULL))
);
-- No duplicate image per POI, and at most one accepted hero per POI, within a batch.
CREATE UNIQUE INDEX uq_poi_media_gers_sha ON poi_media (batch_id, gers_id, sha256) WHERE gers_id IS NOT NULL;
CREATE UNIQUE INDEX uq_poi_media_golden_sha ON poi_media (batch_id, golden_key, sha256) WHERE golden_key IS NOT NULL;
CREATE UNIQUE INDEX uq_poi_media_hero_gers ON poi_media (batch_id, gers_id)
  WHERE role = 'hero' AND status = 'accepted' AND gers_id IS NOT NULL;
CREATE UNIQUE INDEX uq_poi_media_hero_golden ON poi_media (batch_id, golden_key)
  WHERE role = 'hero' AND status = 'accepted' AND golden_key IS NOT NULL;
-- Serving: hero lookup per key and image lookup by content hash.
CREATE INDEX ix_poi_media_gers ON poi_media (gers_id, batch_id) WHERE gers_id IS NOT NULL;
CREATE INDEX ix_poi_media_golden ON poi_media (golden_key, batch_id) WHERE golden_key IS NOT NULL;
CREATE INDEX ix_poi_media_sha ON poi_media (sha256);

-- Bridge to external identifiers, reusable for other enrichment (descriptions, opening hours).
CREATE TABLE poi_entity_links (
  gers_id varchar(40),
  golden_key varchar(120),
  scheme varchar(20) NOT NULL,             -- wikidata|commons_category|wikipedia_vi|wikipedia_en|osm
  value text NOT NULL,
  method varchar(30),
  score numeric(4,3),
  batch_id varchar(40) NOT NULL REFERENCES poi_media_batches(id) ON DELETE CASCADE,
  CHECK ((gers_id IS NULL) <> (golden_key IS NULL))
);
CREATE INDEX ix_poi_entity_links_key ON poi_entity_links (coalesce(golden_key, gers_id), scheme);

INSERT INTO schema_migrations(version) VALUES ('V006');
COMMIT;
