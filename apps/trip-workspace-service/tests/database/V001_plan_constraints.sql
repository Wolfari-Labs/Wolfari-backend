-- Additional Planning constraints. V001 and its original fixture remain immutable.
BEGIN;
INSERT INTO trips(id,name,start_at,end_at,timezone,created_by_user_id) VALUES
('21000000-0000-4000-8000-000000000001','Plan A',now(),now()+interval '2 days','Asia/Ho_Chi_Minh','11000000-0000-4000-8000-000000000001'),
('21000000-0000-4000-8000-000000000002','Plan B',now(),now()+interval '2 days','Asia/Ho_Chi_Minh','11000000-0000-4000-8000-000000000001');
INSERT INTO trip_members(id,trip_id,user_id,role,joined_at) VALUES
('41000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000001','OWNER',now());
INSERT INTO activities(id,trip_id,title,position,created_by_user_id) VALUES
('31000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','A',0,'11000000-0000-4000-8000-000000000001'),
('31000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000001','B',1,'11000000-0000-4000-8000-000000000001');
-- Deferred constraint supports a multi-statement swap.
UPDATE activities SET position=1 WHERE id='31000000-0000-4000-8000-000000000001';
UPDATE activities SET position=0 WHERE id='31000000-0000-4000-8000-000000000002';
SET CONSTRAINTS uq_activities_2 IMMEDIATE;
-- A deferrable immediate constraint is checked at statement end, so bulk reorder also works.
UPDATE activities SET position=1-position WHERE trip_id='21000000-0000-4000-8000-000000000001';
INSERT INTO dress_codes(trip_id,scope_type,activity_id,label,created_by_user_id)
VALUES('21000000-0000-4000-8000-000000000001','ACTIVITY','31000000-0000-4000-8000-000000000001','Boots','11000000-0000-4000-8000-000000000001');
DO $$ BEGIN
 BEGIN
  SET CONSTRAINTS uq_activities_2 DEFERRED;
  UPDATE activities SET position=0 WHERE id='31000000-0000-4000-8000-000000000002';
  SET CONSTRAINTS uq_activities_2 IMMEDIATE;
  RAISE EXCEPTION 'FAIL: duplicate position accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  DELETE FROM activities WHERE id='31000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL: activity with dress code deleted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  UPDATE activities SET status='COMPLETED' WHERE id='31000000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'FAIL: incomplete completion attribution accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO trip_plan_editors(trip_id,trip_member_id,granted_by_user_id)
  VALUES('21000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'FAIL: editor membership from another Trip accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
