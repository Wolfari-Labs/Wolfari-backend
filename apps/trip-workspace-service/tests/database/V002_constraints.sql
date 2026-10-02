BEGIN;
DO $$
DECLARE
  first_trip uuid := gen_random_uuid();
  second_trip uuid := gen_random_uuid();
  actor uuid := gen_random_uuid();
  first_member uuid := gen_random_uuid();
  second_member uuid := gen_random_uuid();
  invitation uuid := gen_random_uuid();
BEGIN
  INSERT INTO trips(id,name,start_at,end_at,timezone,created_by_user_id) VALUES
    (first_trip,'Invitation fixture',now(),now()+interval '2 days','Asia/Ho_Chi_Minh',actor),
    (second_trip,'Foreign fixture',now(),now()+interval '2 days','Asia/Ho_Chi_Minh',actor);
  INSERT INTO trip_members(id,trip_id,user_id,role,joined_at) VALUES
    (first_member,first_trip,actor,'MEMBER',now()),(second_member,second_trip,actor,'MEMBER',now());
  INSERT INTO invitations(id,trip_id,email,invited_by_user_id,token_hash,expires_at,invitation_type)
    VALUES(invitation,first_trip,'Ha@example.test',actor,'fixture-one',now()+interval '1 day','EMAIL');
  BEGIN
    INSERT INTO invitations(trip_id,email,invited_by_user_id,token_hash,expires_at,invitation_type)
      VALUES(first_trip,'  HA@EXAMPLE.TEST  ',actor,'fixture-two',now()+interval '1 day','EMAIL');
    RAISE EXCEPTION 'FAIL duplicate normalized pending email';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE invitations SET status='ACCEPTED' WHERE id=invitation;
    RAISE EXCEPTION 'FAIL missing accepted membership';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE invitations SET status='ACCEPTED',accepted_member_id=second_member WHERE id=invitation;
    RAISE EXCEPTION 'FAIL cross-trip accepted membership';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE invitations SET accepted_member_id=first_member WHERE id=invitation;
    RAISE EXCEPTION 'FAIL pending accepted membership';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE invitations SET status='ACCEPTED',accepted_member_id=first_member WHERE id=invitation;
  INSERT INTO invitations(trip_id,email,invited_by_user_id,token_hash,expires_at,invitation_type)
    VALUES(first_trip,'ha@example.test',actor,'fixture-three',now()+interval '1 day','EMAIL');
END $$;
ROLLBACK;
