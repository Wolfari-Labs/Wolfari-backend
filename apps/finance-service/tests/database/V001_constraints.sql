-- Run on finance_db after V001. Tests source dedupe and immutable ledger.
BEGIN;
INSERT INTO funds(id,trip_id,holder_user_id) VALUES('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
INSERT INTO contribution_requests(id,fund_id,title,created_by_user_id) VALUES('50000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','Fixture','10000000-0000-0000-0000-000000000001');
INSERT INTO contributions(id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version) VALUES('60000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',100000,'CONFIRMED','{}',1);
INSERT INTO fund_transactions(fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,business_key) VALUES('40000000-0000-0000-0000-000000000001',1,'IN','CONTRIBUTION',100000,100000,'60000000-0000-0000-0000-000000000001','test:contribution:1');
DO $$ BEGIN
 BEGIN
  INSERT INTO fund_transactions(fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,business_key) VALUES('40000000-0000-0000-0000-000000000001',2,'IN','CONTRIBUTION',100000,200000,'60000000-0000-0000-0000-000000000001','test:contribution:2');
  RAISE EXCEPTION 'FAIL: second IN accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  UPDATE fund_transactions SET amount=1 WHERE business_key='test:contribution:1';
  RAISE EXCEPTION 'FAIL: ledger update accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Ledger is append-only; use a reversal' THEN RAISE; END IF;
 END;
END $$;
ROLLBACK;
