BEGIN;
DO $$
DECLARE
  fixture_trip uuid := gen_random_uuid();
  fixture_actor uuid := gen_random_uuid();
  fixture_activity uuid;
BEGIN
  INSERT INTO trips(id,name,start_at,end_at,timezone,created_by_user_id)
    VALUES(fixture_trip,'Day-only constraint',now(),now()+interval '2 days','Asia/Ho_Chi_Minh',fixture_actor);
  INSERT INTO activities(trip_id,title,activity_type,position,source,created_by_user_id,scheduled_date)
    VALUES(fixture_trip,'Day','OTHER',0,'MANUAL',fixture_actor,'2026-11-01') RETURNING id INTO fixture_activity;
  BEGIN
    UPDATE activities SET starts_at='2026-11-01T10:00:00Z',ends_at='2026-11-01T11:00:00Z' WHERE id=fixture_activity;
    RAISE EXCEPTION 'FAIL mixed timestamp and day modes';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE activities SET scheduled_date='10000-01-01' WHERE id=fixture_activity;
    RAISE EXCEPTION 'FAIL date outside API calendar range';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF (SELECT scheduled_date FROM activities WHERE id=fixture_activity) <> '2026-11-01'::date THEN
    RAISE EXCEPTION 'FAIL failed updates changed saved date';
  END IF;
  UPDATE activities SET scheduled_date=NULL,starts_at='2026-11-01T10:00:00Z',ends_at='2026-11-01T11:00:00Z' WHERE id=fixture_activity;
END $$;
ROLLBACK;
