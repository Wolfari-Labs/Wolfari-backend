BEGIN;
DO $$
DECLARE
  trip uuid := gen_random_uuid();
  other_trip uuid := gen_random_uuid();
  owner uuid := gen_random_uuid();
  guest uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  other_member uuid := gen_random_uuid();
  link uuid := gen_random_uuid();
  mail uuid := gen_random_uuid();
BEGIN
  INSERT INTO trips(id,name,start_at,end_at,timezone,created_by_user_id) VALUES
    (trip,'Group link fixture',now(),now()+interval '2 days','Asia/Ho_Chi_Minh',owner),
    (other_trip,'Foreign fixture',now(),now()+interval '2 days','Asia/Ho_Chi_Minh',owner);
  INSERT INTO trip_members(id,trip_id,user_id,role,joined_at) VALUES
    (member,trip,guest,'MEMBER',now()),(other_member,other_trip,guest,'MEMBER',now());
  INSERT INTO invitations(id,trip_id,invited_by_user_id,token_hash,expires_at,invitation_type,max_uses)
    VALUES(link,trip,owner,'v007-link',now()+interval '1 day','LINK',5);
  INSERT INTO invitations(id,trip_id,email,invited_by_user_id,token_hash,expires_at,invitation_type)
    VALUES(mail,trip,'guest@example.test',owner,'v007-mail',now()+interval '1 day','EMAIL');
  IF (SELECT max_uses FROM invitations WHERE id=mail) <> 1 OR (SELECT use_count FROM invitations WHERE id=mail) <> 0 THEN
    RAISE EXCEPTION 'FAIL single-use defaults';
  END IF;
  BEGIN
    UPDATE invitations SET max_uses=2 WHERE id=mail;
    RAISE EXCEPTION 'FAIL multi-use EMAIL invitation';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE invitations SET max_uses=51 WHERE id=link;
    RAISE EXCEPTION 'FAIL more than 50 uses';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE invitations SET use_count=6 WHERE id=link;
    RAISE EXCEPTION 'FAIL uses above the limit';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO invitation_acceptances(invitation_id,trip_id,member_id,user_id) VALUES(link,trip,member,guest);
  BEGIN
    INSERT INTO invitation_acceptances(invitation_id,trip_id,member_id,user_id) VALUES(mail,trip,member,guest);
    RAISE EXCEPTION 'FAIL one membership admitted twice';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO invitation_acceptances(invitation_id,trip_id,member_id,user_id) VALUES(link,trip,other_member,guest);
    RAISE EXCEPTION 'FAIL cross-trip admission';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  UPDATE invitations SET use_count=5 WHERE id=link;
END $$;
ROLLBACK;
