-- Wolfari travel_db | V005 | POI-OVERTURE: per-snapshot search indexes and coordinate pile-up flag.
-- Additive only. Every catalogue query now filters on one literal snapshot_id first, so these
-- indexes lead with snapshot_id: an inactive snapshot in the same table does not slow the active one.
-- btree_gin is a trusted extension (PostgreSQL 13+); it lets one GIN index hold snapshot_id + trigrams.
BEGIN;
DO $$ BEGIN IF current_database() <> 'travel_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- true = one of ≥ 20 POIs sharing exactly this coordinate (area-centroid geocodes). Kept for name
-- search, hidden from map (bbox) exploration. Golden POIs are never flagged.
ALTER TABLE pois ADD COLUMN coord_pileup boolean NOT NULL DEFAULT false;

-- One index at a time.
CREATE INDEX ix_pois_snapshot_text ON pois USING gin (snapshot_id, search_text gin_trgm_ops);
CREATE INDEX ix_pois_snapshot_category_geo ON pois (snapshot_id, category, latitude, longitude);

INSERT INTO schema_migrations(version) VALUES ('V005');
COMMIT;
