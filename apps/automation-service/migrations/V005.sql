-- Wolfari automation_db | V005 | Self notification inbox indexes
BEGIN;
DO $$ BEGIN IF current_database() <> 'automation_db' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
SET LOCAL search_path = public;

CREATE INDEX ix_notifications_user_available
  ON notifications (user_id,created_at DESC,id DESC)
  WHERE user_id IS NOT NULL AND status='AVAILABLE';

CREATE INDEX ix_notifications_user_unread
  ON notifications (user_id,created_at DESC,id DESC)
  WHERE user_id IS NOT NULL AND status='AVAILABLE' AND read_at IS NULL;

INSERT INTO schema_migrations(version) VALUES ('V005');
COMMIT;
