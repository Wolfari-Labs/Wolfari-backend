import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runPaymentInstructionTests(h, { newTrip, write, enableBody }) {
  const { query, request, bearer, pass } = h;
  const { owner, holder, member, outsider } = h.actors;
  const trip = await newTrip();
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
    [trip, member.id],
  );
  const body = enableBody();
  body.destination = {
    ...body.destination,
    bank_code: 'VCB',
    account_number: '0001234567',
    account_name: 'TEST INSTRUCTION HOLDER',
  };
  const enabled = await write(`/api/v1/trips/${trip}/fund`, body);
  assert.equal(enabled.status, 201);
  const fund = enabled.body.data.id;
  const dest = (
    await query('finance', 'SELECT * FROM payment_destinations WHERE fund_id=$1', [fund])
  )[0];
  assert.equal(
    (
      await write(
        `/api/v1/funds/${fund}/destinations/${dest.id}/confirm`,
        { expected_version: 1, expected_finance_version: 1 },
        holder,
      )
    ).status,
    200,
  );
  const created = await write(`/api/v1/funds/${fund}/contribution-requests`, {
    title: 'TEST instruction',
    contributions: [{ member_user_id: member.id, amount: '300000', destination_id: dest.id }],
    expected_finance_version: 2,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.contributions[0].id;
  const path = `/api/v1/contributions/${id}/vietqr`;
  const read = (user = member) => request(path, 'GET', undefined, bearer(user));
  const snapshot = async () => ({
    fund: await query('finance', 'SELECT * FROM funds WHERE id=$1', [fund]),
    contribution: await query('finance', 'SELECT * FROM contributions WHERE id=$1', [id]),
    ledger: await query('finance', 'SELECT * FROM fund_transactions WHERE fund_id=$1 ORDER BY id', [
      fund,
    ]),
    audit: await query('finance', 'SELECT * FROM finance_audit_logs WHERE fund_id=$1 ORDER BY id', [
      fund,
    ]),
    outbox: await query(
      'finance',
      'SELECT * FROM outbox_events WHERE aggregate_id=$1 ORDER BY event_id',
      [fund],
    ),
    operations: await query(
      'trip',
      'SELECT * FROM trip_operations WHERE trip_id=$1 ORDER BY operation_id',
      [trip],
    ),
  });
  const before = await snapshot();
  const result = await read();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const instruction = result.body.data;
  const raw = await fetch(h.gatewayUrl + path, {
    headers: bearer(member),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(raw.headers.get('cache-control'), 'private, no-store');
  assert.equal(raw.headers.get('referrer-policy'), 'no-referrer');
  await raw.arrayBuffer();

  assert.equal(instruction.environment, 'TEST');
  assert.equal(instruction.bank_bin, '970436');
  assert.equal(instruction.account_number, '0001234567');
  assert.equal(instruction.amount, '300000');
  assert.match(instruction.reference, /^[A-Z0-9]{25}$/);
  assert.equal(new URL(instruction.qr_url).searchParams.get('amount'), '300000');
  assert.equal(instruction.destination_snapshot, undefined);
  assert.equal(instruction.transfer_evidence_object_key, undefined);
  assert.deepEqual((await read()).body.data, instruction);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await request(path)).status, 401);
  for (const actor of [owner, holder, outsider]) assert.equal((await read(actor)).status, 404);
  assert.equal((await request(path + '?amount=1', 'GET', undefined, bearer(member))).status, 400);
  assert.equal((await request(path, 'POST', {}, bearer(member))).status, 404);
  pass(
    'payment instruction: authenticated Self only, private projection, stable TEST URL and no business writes',
  );

  await query(
    'finance',
    "UPDATE payment_destinations SET bank_code='OTHER',account_number='999',active=false WHERE id=$1",
    [dest.id],
  );
  assert.deepEqual((await read()).body.data, instruction);
  await query('finance', 'UPDATE contributions SET amount=310000 WHERE id=$1', [id]);
  assert.equal((await read()).body.data.amount, '310000');
  await query('finance', 'UPDATE contributions SET amount=300000 WHERE id=$1', [id]);
  // Lifecycle fixtures isolate reader policy; actual writer flows are covered by manual tests.
  for (const status of ['TRANSFER_REPORTED', 'CANCELLED', 'WAIVED']) {
    await query('finance', 'UPDATE contributions SET status=$2 WHERE id=$1', [id, status]);
    assert.equal((await read()).status, 409);
  }
  await query('finance', "UPDATE contributions SET status='PENDING' WHERE id=$1", [id]);
  await query('trip', 'UPDATE trips SET closure_lock_id=$2 WHERE id=$1', [trip, id]);
  assert.equal((await read()).status, 409);
  await query('trip', 'UPDATE trips SET closure_lock_id=NULL,archived_at=now() WHERE id=$1', [
    trip,
  ]);
  assert.equal((await read()).status, 409);
  await query('trip', 'UPDATE trips SET archived_at=NULL WHERE id=$1', [trip]);
  await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
    trip,
    member.id,
  ]);
  assert.equal((await read()).status, 404);
  await query('trip', 'UPDATE trip_members SET left_at=NULL WHERE trip_id=$1 AND user_id=$2', [
    trip,
    member.id,
  ]);
  await query('finance', "UPDATE funds SET status='CLOSING' WHERE id=$1", [fund]);
  assert.equal((await read()).status, 409);
  await query('finance', "UPDATE funds SET status='OPEN',holder_user_id=$2 WHERE id=$1", [
    fund,
    owner.id,
  ]);
  assert.equal((await read()).status, 409);
  await query('finance', 'UPDATE funds SET holder_user_id=$2 WHERE id=$1', [fund, holder.id]);
  pass(
    'payment instruction: immutable destination, current amount, lifecycle/closure/revocation/Holder checks',
  );

  const stored = before.contribution[0].destination_snapshot;
  for (const [change, expected] of [
    [{ schema_version: 2 }, 503],
    [{ destination_version: 999 }, 503],
    [{ destination_type: 'MOMO_SANDBOX' }, 409],
    [{ recipient: { ...stored.recipient, bank_code: 'TEST' } }, 409],
    [{ recipient: { ...stored.recipient, account_number: '12345678901234567890' } }, 409],
  ]) {
    await query('finance', 'UPDATE contributions SET destination_snapshot=$2::jsonb WHERE id=$1', [
      id,
      JSON.stringify({ ...stored, ...change }),
    ]);
    assert.equal((await read()).status, expected);
  }
  await query(
    'finance',
    'UPDATE contributions SET destination_snapshot=$2::jsonb,amount=9007199254740993 WHERE id=$1',
    [id, JSON.stringify(stored)],
  );
  assert.equal((await read()).status, 409);
  await query('finance', 'UPDATE contributions SET amount=300000 WHERE id=$1', [id]);
  assert.equal((await read()).status, 200);
  pass(
    'payment instruction: malformed snapshot fails closed, unsupported bank/account/MoMo/amount never silently changed',
  );

  for (const [status, reconcile, expected] of [
    ['CREATED', false, 409],
    ['PENDING', false, 409],
    ['SUCCEEDED', false, 409],
    ['FAILED', true, 409],
    ['FAILED', false, 200],
    ['EXPIRED', false, 200],
  ]) {
    const attempt = (
      await query(
        'finance',
        `INSERT INTO payment_attempts(contribution_id,provider,environment,amount,client_request_id,status,merchant_id,provider_order_id,destination_snapshot,needs_reconciliation)
       VALUES($1,'VIETQR','TEST',300000,$2,$3,'test',$2,'{}',$4) RETURNING id`,
        [id, randomUUID(), status, reconcile],
      )
    )[0];
    assert.equal((await read()).status, expected);
    await query('finance', 'DELETE FROM payment_attempts WHERE id=$1', [attempt.id]);
  }
  await query('finance', "UPDATE contribution_requests SET status='CLOSED' WHERE id=$1", [
    before.contribution[0].request_id,
  ]);
  assert.equal((await read()).status, 409);
  await query('finance', "UPDATE contribution_requests SET status='OPEN' WHERE id=$1", [
    before.contribution[0].request_id,
  ]);
  await query(
    'finance',
    `INSERT INTO fund_transactions(fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,actor_user_id,business_key)
    VALUES($1,1,'IN','CONTRIBUTION',300000,300000,$2,$3,$4)`,
    [fund, id, holder.id, `contribution:${id}`],
  );
  assert.equal((await read()).status, 409);
  // Keep this append-only ledger fixture; the isolated database is removed by the harness.
  await query('finance', 'UPDATE funds SET current_balance=300000 WHERE id=$1', [fund]);
  await h.whileTripStopped(async () => {
    assert.equal((await read()).status, 503);
  });
  // Process readiness does not imply the existing gRPC channel has reconnected.
  await h.waitFor(async () => (await read()).status === 409);

  pass(
    'payment instruction: pending/reconciled provider fixtures, ledger duplicate, closed request and Trip outage fail closed',
  );
  return [instruction.qr_url, instruction.recipient_name, instruction.account_number];
}
