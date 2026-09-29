-- Run on trip_db after V001. Tests active membership and same-Trip FK.
BEGIN;
INSERT INTO trips(id,name,start_at,end_at,timezone,created_by_user_id) VALUES
('20000000-0000-0000-0000-000000000001','A',now(),now()+interval '2 days','Asia/Ho_Chi_Minh','10000000-0000-0000-0000-000000000001'),
('20000000-0000-0000-0000-000000000002','B',now(),now()+interval '2 days','Asia/Ho_Chi_Minh','10000000-0000-0000-0000-000000000001');
INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES
('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','OWNER',now());
INSERT INTO selected_locations(id,trip_id,name,created_by_user_id) VALUES
('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','Manual without coordinates','10000000-0000-0000-0000-000000000001');
INSERT INTO activities(trip_id,title,position,created_by_user_id) VALUES
('20000000-0000-0000-0000-000000000001','Unscheduled is valid',0,'10000000-0000-0000-0000-000000000001');
DO $$ BEGIN
 BEGIN
  INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','OWNER',now());
  RAISE EXCEPTION 'FAIL: second active owner accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  INSERT INTO activities(trip_id,title,position,selected_location_id,created_by_user_id) VALUES('20000000-0000-0000-0000-000000000001','Wrong Trip',1,'30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
  RAISE EXCEPTION 'FAIL: cross-Trip location accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  UPDATE activities SET starts_at=now(),ends_at=NULL;
  RAISE EXCEPTION 'FAIL: incomplete time pair accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
