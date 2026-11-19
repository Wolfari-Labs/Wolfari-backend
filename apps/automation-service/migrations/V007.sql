-- Wolfari automation_db | V007 | personal reminders and delivery lookup indexes
BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;
ALTER TABLE reminders ADD COLUMN private_context jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX uq_reminders_personal_operation ON reminders(user_id,occurrence_key) WHERE private_context ? 'request_hash';
CREATE INDEX ix_reminders_self_trip ON reminders(user_id,trip_id,created_at DESC,id DESC);
CREATE INDEX ix_reminders_due ON reminders(remind_at,id) WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX ix_notification_deliveries_due ON notification_deliveries(next_attempt_at,id) WHERE status IN ('PENDING','SENDING');
INSERT INTO schema_migrations(version) VALUES ('V007');
COMMIT;
