-- Run on identity_db after V001. Rolls back all fixtures.
BEGIN;
INSERT INTO users(id,email,full_name) VALUES('10000000-0000-0000-0000-000000000001','Case@wolfari.test','Fixture');
DO $$ BEGIN
 BEGIN
  INSERT INTO users(email,full_name) VALUES('case@wolfari.test','Duplicate');
  RAISE EXCEPTION 'FAIL: normalized email duplicate accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
ROLLBACK;
