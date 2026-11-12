-- Run only in an isolated finance_db after V004; all rows are rolled back.
BEGIN;
INSERT INTO funds(id,trip_id,holder_user_id) VALUES('40000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004');
INSERT INTO fund_refunds(id,fund_id,member_user_id,amount,reason,requested_by_user_id)
VALUES('50000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004',1,'Verification fixture','10000000-0000-4000-8000-000000000004');
DO $$ BEGIN
  BEGIN
    UPDATE fund_refunds SET holder_reported_by_user_id='10000000-0000-4000-8000-000000000004' WHERE id='50000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'FAIL: reporter without report timestamp accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE fund_refunds SET verifier_user_id='10000000-0000-4000-8000-000000000005' WHERE id='50000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'FAIL: partial verifier assignment accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE fund_refunds SET independent_verification=true WHERE id='50000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'FAIL: verification without confirmation mode accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE fund_refunds SET confirmation_mode='SELF_UNVERIFIED',independent_verification=true,
      confirmed_by_user_id=member_user_id,confirmed_at=now() WHERE id='50000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'FAIL: inconsistent self verification accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
