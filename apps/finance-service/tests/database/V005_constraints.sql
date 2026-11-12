-- Disposable finance_db only. Verify handover invariants and roll back all fixtures.
BEGIN;
INSERT INTO funds(id,trip_id,holder_user_id) VALUES('40000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000005');
INSERT INTO fund_holder_handovers(id,fund_id,old_holder_user_id,new_holder_user_id,nominated_by_user_id)
VALUES('50000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000006');
DO $$ BEGIN
  BEGIN
    INSERT INTO fund_holder_handovers(fund_id,old_holder_user_id,new_holder_user_id,nominated_by_user_id)
    VALUES('40000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000006');
    RAISE EXCEPTION 'FAIL: concurrent active handover accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE fund_holder_handovers SET status='UNKNOWN' WHERE id='50000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'FAIL: invalid status accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE fund_holder_handovers SET new_holder_user_id=old_holder_user_id WHERE id='50000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'FAIL: identical parties accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE fund_holder_handovers SET status='ACCEPTED',accepted_at=now() WHERE id='50000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'FAIL: acceptance without snapshot accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE fund_holder_handovers SET snapshot_finance_version=1 WHERE id='50000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'FAIL: partial snapshot accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE fund_holder_handovers SET status='COMPLETED',accepted_at=now(),snapshot_finance_version=1,snapshot='{}',completed_at=now() WHERE id='50000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'FAIL: completion without two confirmations accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE fund_holder_handovers SET status='CANCELLED' WHERE id='50000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'FAIL: cancellation without timestamp/reason accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE fund_holder_handovers SET status='CANCELLED',cancelled_at=now(),cancellation_reason='Fixture cancelled' WHERE id='50000000-0000-4000-8000-000000000005';
INSERT INTO fund_holder_handovers(fund_id,old_holder_user_id,new_holder_user_id,nominated_by_user_id)
VALUES('40000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000006');
ROLLBACK;
