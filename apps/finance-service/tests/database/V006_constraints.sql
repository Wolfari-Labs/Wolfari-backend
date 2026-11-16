-- Run only in an isolated finance_db after V006; all rows are rolled back.
BEGIN;
INSERT INTO funds(id,trip_id,holder_user_id) VALUES('40000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000006');
INSERT INTO bank_transfer_receipts(id,provider,provider_transaction_id,transfer_type,amount,content,account_number,payload,processing_status,fund_id)
VALUES('60000000-0000-4000-8000-000000000006','SEPAY','1001','IN',180000,'fixture','0011012345678','{}','UNMATCHED','40000000-0000-4000-8000-000000000006');
DO $$ BEGIN
  BEGIN
    INSERT INTO bank_transfer_receipts(provider,provider_transaction_id,transfer_type,amount,content,account_number,payload,processing_status)
    VALUES('SEPAY','1001','IN',1,'dup','0011012345678','{}','UNMATCHED');
    RAISE EXCEPTION 'FAIL: duplicate provider transaction accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE bank_transfer_receipts SET processing_status='MATCHED' WHERE id='60000000-0000-4000-8000-000000000006';
    RAISE EXCEPTION 'FAIL: MATCHED without contribution accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE bank_transfer_receipts SET contribution_id='70000000-0000-4000-8000-000000000006',processing_status='MATCHED' WHERE id='60000000-0000-4000-8000-000000000006';
    RAISE EXCEPTION 'FAIL: unknown contribution accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO bank_transfer_receipts(provider,provider_transaction_id,transfer_type,amount,content,account_number,payload,processing_status)
    VALUES('SEPAY','1002','SIDEWAYS',1,'x','0011012345678','{}','UNMATCHED');
    RAISE EXCEPTION 'FAIL: invalid transfer type accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
