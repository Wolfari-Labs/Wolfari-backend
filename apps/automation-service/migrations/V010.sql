-- Scheduled Finance reminders (SRS FR-AU01): a contribution request 24 h before its deadline and
-- at most once a day while overdue; a pending Fund closure once a day. A row only says "look at
-- this source again at next_at"; who is reminded and whether it is still due is read from Finance.
BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
CREATE TABLE finance_reminder_schedules (
  source_type varchar(24) NOT NULL,
  source_id uuid NOT NULL,
  fund_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  next_at timestamptz NOT NULL,
  sent_count integer NOT NULL DEFAULT 0,
  claim_owner uuid,
  claim_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_finance_reminder_schedules PRIMARY KEY (source_type, source_id),
  CONSTRAINT ck_finance_reminder_schedules_type CHECK (source_type IN ('CONTRIBUTION_REQUEST', 'CLOSURE')),
  CONSTRAINT ck_finance_reminder_schedules_count CHECK (sent_count BETWEEN 0 AND 60)
);
CREATE INDEX ix_finance_reminder_schedules_next ON finance_reminder_schedules (next_at);
INSERT INTO schema_migrations(version) VALUES ('V010');
COMMIT;
