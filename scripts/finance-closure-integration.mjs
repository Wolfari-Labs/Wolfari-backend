import { runClosureConcurrencyTests } from './finance-concurrency-integration.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export async function runClosureTests(h, helpers) {
  const { request, query, bearer, waitFor, pass } = h;
  const { owner, holder, outsider, member } = h.actors;
  const { newTrip, write, enableBody, repo, tripClient, fundCommandHash } = helpers;

  const addOutsider = (tripId) =>
    query(
      'trip',
      "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
      [tripId, outsider.id],
    );
  const fundState = async (fundId) =>
    (
      await query('finance', 'SELECT status,finance_version,closed_at FROM funds WHERE id=$1', [
        fundId,
      ])
    )[0];
  const tripLock = async (tripId) =>
    (await query('trip', 'SELECT closure_lock_id FROM trips WHERE id=$1', [tripId]))[0]
      .closure_lock_id;
  const mutate = async (path, body, user = owner, key = randomUUID(), method = 'POST') => {
    const invoke = () => request(path, method, body, { ...bearer(user), 'idempotency-key': key });
    const first = await invoke();
    if (first.status !== 202 || first.body?.data?.accepted === true) return first;
    assert.equal(first.body.data.operation_id, key);
    await waitFor(async () => {
      const polled = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
      return polled.status === 200 && ['SUCCEEDED', 'FAILED'].includes(polled.body.data.state);
    });
    return invoke();
  };
  const createFund = async () => {
    const tripId = await newTrip();
    await addOutsider(tripId);
    const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody());
    assert.equal(enabled.status, 201, JSON.stringify(enabled.body));
    return {
      tripId,
      fundId: enabled.body.data.id,
      financeVersion: enabled.body.data.finance_version,
    };
  };
  const createClosure = async (fixture, key = randomUUID()) => {
    const result = await mutate(
      `/api/v1/funds/${fixture.fundId}/closures`,
      { expected_finance_version: fixture.financeVersion },
      owner,
      key,
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    fixture.financeVersion = result.body.data.finance_version;
    return result.body.data;
  };
  const action = async (closure, name, body, user, key = randomUUID()) => {
    const result = await mutate(`/api/v1/closures/${closure.id}/${name}`, body, user, key);
    assert.equal(result.status, name === 'remind' ? 202 : 200, JSON.stringify(result.body));
    return result;
  };
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;

  const lifecycle = await createFund();
  const closure = await createClosure(lifecycle);
  assert.equal(closure.status, 'PENDING_CONFIRMATIONS');
  assert.equal((await fundState(lifecycle.fundId)).status, 'CLOSING');
  assert.equal(await tripLock(lifecycle.tripId), closure.id);
  assert.deepEqual(closure.snapshot.required_user_ids, [owner.id, holder.id, outsider.id].sort());
  assert.equal(closure.snapshot.fund.finance_version, closure.snapshot_finance_version);
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(canonical(closure.snapshot)))
      .digest('hex'),
    closure.snapshot_hash,
  );
  assert.equal(JSON.stringify(closure.snapshot).includes('PRIVATE WRITE HOLDER'), false);
  assert.equal(JSON.stringify(closure.snapshot).includes('000987654321'), false);
  assert.equal(JSON.stringify(closure.snapshot).includes('receipt_object_key'), false);
  assert.equal(JSON.stringify(closure.snapshot).includes('provider_payload'), false);

  const collection = `/api/v1/funds/${lifecycle.fundId}/closures`;
  const list = await request(`${collection}?limit=1`, 'GET', undefined, bearer(holder));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.data.items[0].id, closure.id);
  assert.equal(
    (await request(`/api/v1/closures/${closure.id}`, 'GET', undefined, bearer(outsider))).status,
    200,
  );
  assert.equal(
    (
      await mutate(
        `/api/v1/funds/${lifecycle.fundId}/budget`,
        { budget_amount: '1', expected_finance_version: lifecycle.financeVersion },
        owner,
        randomUUID(),
        'PATCH',
      )
    ).status,
    409,
  );
  assert.equal((await mutate(`/api/v1/closures/${closure.id}/remind`, {}, holder)).status, 403);
  const invitation = await request(
    `/api/v1/trips/${lifecycle.tripId}/invitations`,
    'POST',
    { invitation_type: 'LINK', expected_membership_revision: 1 },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assert.equal(invitation.status, 201);
  const invitationToken = new URLSearchParams(
    new URL(invitation.body.data.one_time_link).hash.slice(1),
  ).get('token');
  assert.equal(
    (
      await request(
        '/api/v1/invitations/accept',
        'POST',
        { token: invitationToken },
        { ...bearer(member), 'idempotency-key': randomUUID() },
      )
    ).status,
    409,
  );
  const beforeRemind = Number(
    (
      await query(
        'finance',
        "SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1 AND event_type='ClosureRequested'",
        [lifecycle.fundId],
      )
    )[0].n,
  );
  await action(closure, 'remind', {}, owner);
  assert.equal(
    Number(
      (
        await query(
          'finance',
          "SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1 AND event_type='ClosureRequested'",
          [lifecycle.fundId],
        )
      )[0].n,
    ),
    beforeRemind + 1,
  );

  const confirmKey = randomUUID();
  let confirmed = (
    await action(closure, 'confirm', { snapshot_hash: closure.snapshot_hash }, owner, confirmKey)
  ).body.data;
  lifecycle.financeVersion = confirmed.finance_version;
  assert.equal(confirmed.status, 'PENDING_CONFIRMATIONS');
  assert.deepEqual(
    (await action(closure, 'confirm', { snapshot_hash: closure.snapshot_hash }, owner, confirmKey))
      .body.data,
    confirmed,
  );
  assert.equal(
    (
      await mutate(
        `/api/v1/closures/${closure.id}/confirm`,
        { snapshot_hash: '0'.repeat(64) },
        holder,
      )
    ).status,
    409,
  );
  confirmed = (await action(closure, 'confirm', { snapshot_hash: closure.snapshot_hash }, holder))
    .body.data;
  assert.equal(confirmed.status, 'PENDING_CONFIRMATIONS');
  confirmed = (await action(closure, 'confirm', { snapshot_hash: closure.snapshot_hash }, outsider))
    .body.data;
  assert.equal(confirmed.status, 'COMPLETED');
  assert.equal(confirmed.snapshot_hash, closure.snapshot_hash);
  assert.deepEqual(confirmed.snapshot, closure.snapshot);
  assert(confirmed.closed_at);
  assert.equal((await fundState(lifecycle.fundId)).status, 'CLOSED');
  assert.equal(await tripLock(lifecycle.tripId), null);
  assert.equal(
    (
      await query(
        'finance',
        "SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1 AND event_type='FinanceClosed'",
        [lifecycle.fundId],
      )
    )[0].n,
    1,
  );
  pass('Closure requires the immutable member snapshot and closes only after every confirmation');

  const cancelledFixture = await createFund();
  const cancelledClosure = await createClosure(cancelledFixture);
  await action(
    cancelledClosure,
    'confirm',
    { snapshot_hash: cancelledClosure.snapshot_hash },
    holder,
  );
  const cancelled = (
    await action(cancelledClosure, 'cancel', { reason: 'Cần điều chỉnh sổ quỹ' }, owner)
  ).body.data;
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal((await fundState(cancelledFixture.fundId)).status, 'OPEN');
  assert.equal(await tripLock(cancelledFixture.tripId), null);
  cancelledFixture.financeVersion = cancelled.finance_version;
  const replacement = await createClosure(cancelledFixture);
  assert.notEqual(replacement.id, cancelledClosure.id);
  assert(replacement.confirmations.every((item) => item.confirmed_at === null));
  await action(replacement, 'cancel', { reason: 'Dọn fixture' }, owner);
  pass('Owner cancellation releases the Trip lock and a new snapshot inherits no old confirmation');

  const blocked = await createFund();
  const requestId = randomUUID();
  await query(
    'finance',
    `INSERT INTO contribution_requests(id,fund_id,title,status,created_by_user_id)
     VALUES($1,$2,'Closure blocker','OPEN',$3)`,
    [requestId, blocked.fundId, owner.id],
  );
  await query(
    'finance',
    `INSERT INTO contributions(request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version)
     VALUES($1,$2,$3,1,'PENDING','{}',1)`,
    [requestId, blocked.fundId, outsider.id],
  );
  assert.equal(
    (
      await mutate(`/api/v1/funds/${blocked.fundId}/closures`, {
        expected_finance_version: blocked.financeVersion,
      })
    ).status,
    409,
  );
  await query(
    'finance',
    "UPDATE contributions SET status='WAIVED',waived_reason='fixture',waived_at=now() WHERE request_id=$1",
    [requestId],
  );
  await query(
    'finance',
    "UPDATE contribution_requests SET status='CLOSED',closed_at=now() WHERE id=$1",
    [requestId],
  );
  const contributionId = (
    await query('finance', 'SELECT id FROM contributions WHERE request_id=$1', [requestId])
  )[0].id;
  const attemptId = randomUUID();
  await query(
    'finance',
    `INSERT INTO payment_attempts
     (id,contribution_id,provider,environment,amount,client_request_id,status,merchant_id,provider_order_id,destination_snapshot)
     VALUES($1,$2,'VIETQR','TEST',1,$3,'CREATED','fixture',$4,'{}')`,
    [attemptId, contributionId, randomUUID(), randomUUID()],
  );
  assert.equal(
    (
      await mutate(`/api/v1/funds/${blocked.fundId}/closures`, {
        expected_finance_version: blocked.financeVersion,
      })
    ).status,
    409,
  );
  await query('finance', "UPDATE payment_attempts SET status='SUCCEEDED' WHERE id=$1", [attemptId]);
  assert.equal(
    (
      await mutate(`/api/v1/funds/${blocked.fundId}/closures`, {
        expected_finance_version: blocked.financeVersion,
      })
    ).status,
    409,
  );
  const transactionId = randomUUID();
  await query(
    'finance',
    `UPDATE contributions SET status='CONFIRMED',confirmed_at=now(),confirmed_by_user_id=$2 WHERE id=$1`,
    [contributionId, holder.id],
  );
  await query(
    'finance',
    `INSERT INTO fund_transactions
     (id,fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,actor_user_id,business_key)
     VALUES($1,$2,1,'IN','CONTRIBUTION',1,1,$3,$4,$5)`,
    [transactionId, blocked.fundId, contributionId, holder.id, `closure:${transactionId}`],
  );
  assert.equal(
    (
      await mutate(`/api/v1/funds/${blocked.fundId}/closures`, {
        expected_finance_version: blocked.financeVersion,
      })
    ).status,
    409,
  );
  const reversalId = randomUUID();
  await query(
    'finance',
    `INSERT INTO fund_transactions
     (fund_id,sequence,direction,transaction_type,amount,balance_after,reversal_of_id,actor_user_id,reason,business_key)
     VALUES($1,2,'OUT','REVERSAL',1,0,$2,$3,'fixture',$4)`,
    [blocked.fundId, transactionId, holder.id, `closure:${reversalId}`],
  );
  await query(
    'finance',
    "UPDATE contributions SET status='REVERSED',reversed_at=now() WHERE id=$1",
    [contributionId],
  );
  const webhookId = randomUUID();
  await query(
    'finance',
    `INSERT INTO payment_webhook_receipts
     (id,provider,environment,dedupe_key,payment_attempt_id,signature_valid,payload,processing_status)
     VALUES($1,'VIETQR','TEST',$2,$3,true,'{}','RECEIVED')`,
    [webhookId, randomUUID(), attemptId],
  );
  assert.equal(
    (
      await mutate(`/api/v1/funds/${blocked.fundId}/closures`, {
        expected_finance_version: blocked.financeVersion,
      })
    ).status,
    409,
  );
  await query(
    'finance',
    "UPDATE payment_webhook_receipts SET processing_status='PROCESSED',processed_at=now() WHERE id=$1",
    [webhookId],
  );
  const expenseId = randomUUID();
  await query(
    'finance',
    `INSERT INTO fund_expenses(id,fund_id,title,amount,status,created_by_user_id)
     VALUES($1,$2,'Closure draft',1,'DRAFT',$3)`,
    [expenseId, blocked.fundId, outsider.id],
  );
  assert.equal(
    (
      await mutate(`/api/v1/funds/${blocked.fundId}/closures`, {
        expected_finance_version: blocked.financeVersion,
      })
    ).status,
    409,
  );
  await query('finance', 'UPDATE fund_expenses SET deleted_at=now() WHERE id=$1', [expenseId]);
  const refundId = randomUUID();
  await query(
    'finance',
    `INSERT INTO fund_refunds(id,fund_id,member_user_id,amount,status,reason,requested_by_user_id)
     VALUES($1,$2,$3,1,'PENDING','fixture',$4)`,
    [refundId, blocked.fundId, outsider.id, owner.id],
  );
  assert.equal(
    (
      await mutate(`/api/v1/funds/${blocked.fundId}/closures`, {
        expected_finance_version: blocked.financeVersion,
      })
    ).status,
    409,
  );
  await query(
    'finance',
    "UPDATE fund_refunds SET status='CONFIRMED',confirmed_at=now(),reversal_requested_at=now() WHERE id=$1",
    [refundId],
  );
  assert.equal(
    (
      await mutate(`/api/v1/funds/${blocked.fundId}/closures`, {
        expected_finance_version: blocked.financeVersion,
      })
    ).status,
    409,
  );
  await query(
    'finance',
    "UPDATE fund_refunds SET status='REVERSED',reversal_consented_at=now() WHERE id=$1",
    [refundId],
  );
  await query('finance', 'UPDATE funds SET current_balance=1 WHERE id=$1', [blocked.fundId]);
  assert.equal(
    (
      await mutate(`/api/v1/funds/${blocked.fundId}/closures`, {
        expected_finance_version: blocked.financeVersion,
      })
    ).status,
    409,
  );
  await query('finance', 'UPDATE funds SET current_balance=0 WHERE id=$1', [blocked.fundId]);
  const afterBlocker = await createClosure(blocked);
  await action(afterBlocker, 'cancel', { reason: 'Dọn fixture' }, owner);
  pass(
    'Closure blocks unfinished contribution/attempt/webhook/expense/refund/reversal and balance mismatches',
  );

  const recovery = await createFund();
  const createOperation = randomUUID();
  const createCommand = {
    scope: 'CREATE_CLOSURE',
    actor: owner.id,
    tripId: recovery.tripId,
    fundId: recovery.fundId,
    body: { expectedFinanceVersion: recovery.financeVersion },
  };
  const createInput = {
    ...createCommand,
    operationId: createOperation,
    hash: fundCommandHash(createCommand),
  };
  const createGuard = await tripClient.call(
    'BeginFinanceOperation',
    {
      operation_id: createOperation,
      trip_id: recovery.tripId,
      actor: { actor_user_id: owner.id },
      command: createInput.scope,
      request_hash: createInput.hash,
    },
    randomUUID(),
    Date.now() + 5000,
  );
  const committedCreate = await repo.execute(createInput, createGuard, randomUUID());
  assert.equal(committedCreate.status, 'COMMITTED');
  const recoveredClosure = committedCreate.response.closure;
  assert.equal(await tripLock(recovery.tripId), null);
  await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
    createOperation,
  ]);
  await waitFor(async () => (await tripLock(recovery.tripId)) === recoveredClosure.id);
  const createReplay = await mutate(
    `/api/v1/funds/${recovery.fundId}/closures`,
    { expected_finance_version: recovery.financeVersion },
    owner,
    createOperation,
  );
  assert.equal(createReplay.status, 201, JSON.stringify(createReplay.body));
  assert.equal(createReplay.body.data.id, recoveredClosure.id);

  const cancelOperation = randomUUID();
  const cancelCommand = {
    scope: 'CANCEL_CLOSURE',
    actor: owner.id,
    tripId: recovery.tripId,
    fundId: recovery.fundId,
    closureId: recoveredClosure.id,
    body: { reason: 'Recovery release' },
  };
  const cancelInput = {
    ...cancelCommand,
    operationId: cancelOperation,
    hash: fundCommandHash(cancelCommand),
  };
  const cancelGuard = await tripClient.call(
    'BeginFinanceOperation',
    {
      operation_id: cancelOperation,
      trip_id: recovery.tripId,
      actor: { actor_user_id: owner.id },
      command: cancelInput.scope,
      request_hash: cancelInput.hash,
    },
    randomUUID(),
    Date.now() + 5000,
  );
  assert.equal((await repo.execute(cancelInput, cancelGuard, randomUUID())).status, 'COMMITTED');
  assert.equal(await tripLock(recovery.tripId), recoveredClosure.id);
  await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
    cancelOperation,
  ]);
  await waitFor(async () => (await tripLock(recovery.tripId)) === null);
  const cancelReplay = await mutate(
    `/api/v1/closures/${recoveredClosure.id}/cancel`,
    { reason: 'Recovery release' },
    owner,
    cancelOperation,
  );
  assert.equal(cancelReplay.status, 200, JSON.stringify(cancelReplay.body));
  assert.equal(cancelReplay.body.data.status, 'CANCELLED');
  pass(
    'Closure lock set/release effects recover from committed Finance receipts without replaying money',
  );
  await runClosureConcurrencyTests(h, {
    financeDb: helpers.financeDb,
    createFund,
    createClosure,
    action,
  });
}
