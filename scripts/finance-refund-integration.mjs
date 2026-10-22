import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runRefundTests(h, helpers) {
  const { request, query, bearer, waitFor, pass } = h;
  const { owner, holder, outsider } = h.actors;
  const { newTrip, write, enableBody, repo, tripClient, fundCommandHash } = helpers;
  const mutate = async (path, body, user, key = randomUUID()) => {
    const headers = { ...bearer(user), 'idempotency-key': key };
    const first = await request(path, 'POST', body, headers);
    if (first.status !== 202) return first;
    await waitFor(async () => {
      const polled = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
      return polled.status === 200 && ['SUCCEEDED', 'FAILED'].includes(polled.body.data.state);
    });
    return request(path, 'POST', body, headers);
  };
  const tripId = await newTrip();
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
    [tripId, outsider.id],
  );
  const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody());
  assert.equal(enabled.status, 201);
  const fundId = enabled.body.data.id;
  const requestId = randomUUID(),
    contributionId = randomUUID();
  await query(
    'finance',
    `INSERT INTO contribution_requests(id,fund_id,title,amount_per_member,status,created_by_user_id)
    VALUES($1,$2,'Refund fixture',300000,'CLOSED',$3)`,
    [requestId, fundId, owner.id],
  );
  await query(
    'finance',
    `INSERT INTO contributions
    (id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version,confirmed_by_user_id,confirmed_at)
    VALUES($1,$2,$3,$4,300000,'CONFIRMED','{}',1,$5,now())`,
    [contributionId, requestId, fundId, owner.id, holder.id],
  );
  await query(
    'finance',
    `INSERT INTO fund_transactions
    (fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,actor_user_id,business_key)
    VALUES($1,1,'IN','CONTRIBUTION',300000,300000,$2,$3,$4)`,
    [fundId, contributionId, holder.id, `fixture:${contributionId}`],
  );
  let financeVersion = (
    await query(
      'finance',
      `UPDATE funds SET current_balance=300000,
    finance_version=finance_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING finance_version`,
      [fundId],
    )
  )[0].finance_version;
  const collection = `/api/v1/funds/${fundId}/refunds`;
  const create = async (memberUserId, amount) => {
    const result = await mutate(
      collection,
      {
        member_user_id: memberUserId,
        amount,
        reason: 'Hoàn phần dư',
        expected_finance_version: financeVersion,
      },
      owner,
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    financeVersion = result.body.data.finance_version;
    return result.body.data;
  };
  const first = await create(outsider.id, '100000');
  const second = await create(holder.id, '200000');
  const over = await mutate(
    collection,
    {
      member_user_id: holder.id,
      amount: '1',
      reason: 'Quá số dư',
      expected_finance_version: financeVersion,
    },
    owner,
  );
  assert.equal(over.status, 409);
  const list = await request(`${collection}?limit=2`, 'GET', undefined, bearer(outsider));
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items.length, 2);
  assert.equal(Object.hasOwn(list.body.data.items[0], 'requested_by_user_id'), false);

  const act = async (id, action, body, user) => {
    const result = await mutate(`/api/v1/refunds/${id}/${action}`, body, user);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    financeVersion = result.body.data.finance_version;
    return result.body.data;
  };
  let a = await act(
    first.id,
    'report-paid',
    { expected_version: first.version, expected_finance_version: financeVersion },
    holder,
  );
  let balance = (
    await query('finance', 'SELECT current_balance::text FROM funds WHERE id=$1', [fundId])
  )[0].current_balance;
  assert.equal(balance, '300000');
  a = await act(
    a.id,
    'confirm-received',
    { expected_version: a.version, expected_finance_version: financeVersion },
    outsider,
  );
  assert.equal(a.status, 'CONFIRMED');
  let b = await act(
    second.id,
    'report-paid',
    { expected_version: second.version, expected_finance_version: financeVersion },
    holder,
  );
  b = await act(
    b.id,
    'confirm-nonreceipt',
    {
      reason: 'Chưa nhận tiền',
      expected_version: b.version,
      expected_finance_version: financeVersion,
    },
    holder,
  );
  b = await act(
    b.id,
    'cancel',
    {
      reason: 'Hủy để chuyển lại',
      expected_version: b.version,
      expected_finance_version: financeVersion,
    },
    owner,
  );
  assert.equal(b.status, 'CANCELLED');

  let c = await create(holder.id, '200000');
  c = await act(
    c.id,
    'report-paid',
    { expected_version: c.version, expected_finance_version: financeVersion },
    holder,
  );
  c = await act(
    c.id,
    'confirm-received',
    { expected_version: c.version, expected_finance_version: financeVersion },
    holder,
  );
  balance = (
    await query('finance', 'SELECT current_balance::text FROM funds WHERE id=$1', [fundId])
  )[0].current_balance;
  assert.equal(balance, '0');
  c = await act(
    c.id,
    'request-reversal',
    {
      reason: 'Chuyển nhầm',
      expected_version: c.version,
      expected_finance_version: financeVersion,
    },
    holder,
  );
  c = await act(
    c.id,
    'consent-reversal',
    { expected_version: c.version, expected_finance_version: financeVersion },
    holder,
  );
  const mismatch = await mutate(
    `/api/v1/refunds/${c.id}/reverse`,
    { reason: 'Lý do khác', expected_version: c.version, expected_finance_version: financeVersion },
    holder,
  );
  assert.equal(mismatch.status, 409);
  c = await act(
    c.id,
    'reverse',
    {
      reason: 'Chuyển nhầm',
      expected_version: c.version,
      expected_finance_version: financeVersion,
    },
    holder,
  );
  assert.equal(c.status, 'REVERSED');
  const final = (
    await query(
      'finance',
      `SELECT f.current_balance::text,
    COALESCE(SUM(CASE WHEN t.direction='IN' THEN t.amount ELSE -t.amount END),0)::text ledger_balance
    FROM funds f LEFT JOIN fund_transactions t ON t.fund_id=f.id WHERE f.id=$1 GROUP BY f.id`,
      [fundId],
    )
  )[0];
  assert.deepEqual(final, { current_balance: '200000', ledger_balance: '200000' });
  assert.equal(
    (
      await query(
        'finance',
        "SELECT count(*)::int n FROM fund_transactions WHERE fund_id=$1 AND transaction_type='REFUND'",
        [fundId],
      )
    )[0].n,
    2,
  );
  assert.equal(
    (
      await query(
        'finance',
        "SELECT count(*)::int n FROM fund_transactions WHERE fund_id=$1 AND transaction_type='REVERSAL'",
        [fundId],
      )
    )[0].n,
    1,
  );
  const recoveryId = randomUUID();
  const recoveryBody = {
    member_user_id: outsider.id,
    amount: '1',
    reason: 'Recovery refund',
    expected_finance_version: financeVersion,
  };
  const command = {
    scope: 'CREATE_REFUND',
    actor: owner.id,
    tripId,
    fundId,
    body: {
      memberUserId: outsider.id,
      amount: 1n,
      reason: recoveryBody.reason,
      expectedFinanceVersion: financeVersion,
    },
  };
  const input = { ...command, operationId: recoveryId, hash: fundCommandHash(command) };
  const guard = await tripClient.call(
    'BeginFinanceOperation',
    {
      operation_id: recoveryId,
      trip_id: tripId,
      actor: { actor_user_id: owner.id },
      command: input.scope,
      request_hash: input.hash,
    },
    randomUUID(),
    Date.now() + 5000,
  );
  assert.equal((await repo.execute(input, guard, randomUUID())).status, 'COMMITTED');
  await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
    recoveryId,
  ]);
  let recoveredState;
  await waitFor(async () => {
    const result = await request(
      `/api/v1/operations/${recoveryId}`,
      'GET',
      undefined,
      bearer(owner),
    );
    recoveredState = result.body?.data?.state;
    return result.status === 200 && ['SUCCEEDED', 'FAILED'].includes(recoveredState);
  });
  assert.equal(recoveredState, 'SUCCEEDED');
  const replay = await mutate(collection, recoveryBody, owner, recoveryId);
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  financeVersion = replay.body.data.finance_version;
  await act(
    replay.body.data.id,
    'cancel',
    {
      reason: 'Cleanup recovery fixture',
      expected_version: replay.body.data.version,
      expected_finance_version: financeVersion,
    },
    owner,
  );
  pass(
    'Refund API111-119 preserves reservations, recipient consent and append-only ledger balance',
  );
}
