-- Run only in an isolated finance_db after V007; all rows are rolled back.
BEGIN;
INSERT INTO funds(id,trip_id,holder_user_id) VALUES('40000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000007');
INSERT INTO bank_transfer_receipts(id,provider,provider_transaction_id,transfer_type,amount,content,account_number,payload,processing_status,review_reason,fund_id)
VALUES('60000000-0000-4000-8000-000000000007','SEPAY','2001','IN',180000,'fixture','0011012345678','{}','NEEDS_REVIEW','AMOUNT_MISMATCH','40000000-0000-4000-8000-000000000007');
DO $$ BEGIN
  BEGIN
    UPDATE bank_transfer_receipts SET processing_status='RESOLVED' WHERE id='60000000-0000-4000-8000-000000000007';
    RAISE EXCEPTION 'FAIL: RESOLVED without resolution details accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE bank_transfer_receipts SET resolution='GUESSED' WHERE id='60000000-0000-4000-8000-000000000007';
    RAISE EXCEPTION 'FAIL: unknown resolution accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE bank_transfer_receipts SET processing_status='RESOLVED',resolution='NOT_OURS',resolution_note='',
      resolved_by_user_id='10000000-0000-4000-8000-000000000007',resolved_at=now(),
      resolution_operation_id='80000000-0000-4000-8000-000000000007'
    WHERE id='60000000-0000-4000-8000-000000000007';
    RAISE EXCEPTION 'FAIL: empty resolution note accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE bank_transfer_receipts SET resolution='NOT_OURS',resolution_note='Chuyển nhầm',
      resolved_by_user_id='10000000-0000-4000-8000-000000000007',resolved_at=now(),
      resolution_operation_id='80000000-0000-4000-8000-000000000007'
    WHERE id='60000000-0000-4000-8000-000000000007';
    RAISE EXCEPTION 'FAIL: resolution details on an unresolved transfer accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE bank_transfer_receipts SET processing_status='RESOLVED',resolution='NOT_OURS',resolution_note='Chuyển nhầm',
  resolved_by_user_id='10000000-0000-4000-8000-000000000007',resolved_at=now(),
  resolution_operation_id='80000000-0000-4000-8000-000000000007'
WHERE id='60000000-0000-4000-8000-000000000007';
ROLLBACK;
