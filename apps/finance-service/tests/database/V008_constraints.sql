-- Run only in an isolated finance_db after V008: read-only checks of the payOS constraints.
DO $$
DECLARE provider_rule text; environment_rule text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO provider_rule FROM pg_constraint
   WHERE conrelid='payment_attempts'::regclass AND conname='ck_payment_attempts_3';
  SELECT pg_get_constraintdef(oid) INTO environment_rule FROM pg_constraint
   WHERE conrelid='payment_attempts'::regclass AND conname='ck_payment_attempts_4';
  IF provider_rule IS NULL OR provider_rule NOT LIKE '%''PAYOS''%' OR provider_rule NOT LIKE '%''MOMO_SANDBOX''%'
     OR provider_rule NOT LIKE '%''VIETQR''%' THEN
    RAISE EXCEPTION 'FAIL: payment_attempts provider rule %', provider_rule;
  END IF;
  IF environment_rule IS NULL OR environment_rule NOT LIKE '%''LIVE''%' OR environment_rule NOT LIKE '%''SANDBOX''%'
     OR environment_rule NOT LIKE '%''TEST''%' THEN
    RAISE EXCEPTION 'FAIL: payment_attempts environment rule %', environment_rule;
  END IF;
END $$;
