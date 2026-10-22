-- Wolfari automation_db | V004 | durable Price Watch alert evaluation and lifecycle ordering
BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;

CREATE TABLE price_alert_candidates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  watch_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  watch_version integer NOT NULL,
  reason varchar(24) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_owner varchar(100),
  claim_until timestamptz,
  last_error varchar(60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT pk_price_alert_candidates PRIMARY KEY (id),
  CONSTRAINT ck_price_alert_candidates_1 CHECK (watch_version > 0),
  CONSTRAINT ck_price_alert_candidates_2 CHECK (attempt_count >= 0),
  CONSTRAINT ck_price_alert_candidates_3 CHECK (reason IN ('FIRST','REARMED','DROP_5_PERCENT')),
  CONSTRAINT ck_price_alert_candidates_4 CHECK (status IN ('PENDING','PROCESSING','NOTIFIED','SUPPRESSED','SUPERSEDED','FAILED')),
  CONSTRAINT uq_price_alert_candidates_1 UNIQUE (watch_id, observation_id),
  CONSTRAINT fk_price_alert_candidates_1 FOREIGN KEY (watch_id) REFERENCES price_watches (id) ON DELETE NO ACTION,
  CONSTRAINT fk_price_alert_candidates_2 FOREIGN KEY (observation_id) REFERENCES price_observations (id) ON DELETE NO ACTION
);
CREATE UNIQUE INDEX uq_price_alert_candidates_open_watch
  ON price_alert_candidates (watch_id)
  WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX ix_price_alert_candidates_claim
  ON price_alert_candidates (status,next_attempt_at,claim_until,created_at)
  WHERE status IN ('PENDING','PROCESSING');

CREATE TABLE price_watch_trip_lifecycle (
  trip_id uuid NOT NULL,
  export_revision integer NOT NULL,
  state varchar(16) NOT NULL,
  event_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_price_watch_trip_lifecycle PRIMARY KEY (trip_id),
  CONSTRAINT ck_price_watch_trip_lifecycle_1 CHECK (export_revision > 0),
  CONSTRAINT ck_price_watch_trip_lifecycle_2 CHECK (state IN ('ACTIVE','ARCHIVED','DELETED')),
  CONSTRAINT uq_price_watch_trip_lifecycle_1 UNIQUE (event_id)
);
COMMENT ON COLUMN price_watch_trip_lifecycle.trip_id IS 'Logical reference to Trip.trips; no cross-service FK';

INSERT INTO schema_migrations(version) VALUES ('V004');
COMMIT;
