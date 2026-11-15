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
  const selfConfirmBody = { expected_version: c.version, expected_finance_version: financeVersion };
  const selfDenied = await mutate(
    `/api/v1/refunds/${c.id}/confirm-received`,
    selfConfirmBody,
    holder,
  );
  assert.equal(selfDenied.status, 403, JSON.stringify(selfDenied.body));
  assert.equal(
    (await query('finance', 'SELECT current_balance::text FROM funds WHERE id=$1', [fundId]))[0]
      .current_balance,
    '200000',
  );
  const ownerConfirmKey = randomUUID();
  const verified = await mutate(
    `/api/v1/refunds/${c.id}/confirm-received`,
    selfConfirmBody,
    owner,
    ownerConfirmKey,
  );
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  c = verified.body.data;
  financeVersion = c.finance_version;
  assert.equal(c.confirmed_by_user_id, owner.id);
  assert.equal(c.confirmation_mode, 'OWNER');
  assert.equal(c.independent_verification, true);
  const confirmReplay = await mutate(
    `/api/v1/refunds/${c.id}/confirm-received`,
    selfConfirmBody,
    owner,
    ownerConfirmKey,
  );
  assert.deepEqual(confirmReplay.body.data, c);
  const storedVerification = (
    await query(
      'finance',
      'SELECT confirmed_by_user_id,confirmation_mode,independent_verification FROM fund_refunds WHERE id=$1',
      [c.id],
    )
  )[0];
  assert.deepEqual(storedVerification, {
    confirmed_by_user_id: owner.id,
    confirmation_mode: 'OWNER',
    independent_verification: true,
  });
  /* Legacy same-Holder confirmation is replaced by the current Owner's verified
     confirmation above. Its receipt replay must not append a second OUT. */
  balance = (
    await query('finance', 'SELECT current_balance::text FROM funds WHERE id=$1', [fundId])
  )[0].current_balance;
  assert.equal(balance, '0');
  const reversalReason = '😀'.repeat(1024);
  c = await act(
    c.id,
    'request-reversal',
    {
      reason: reversalReason,
      expected_version: c.version,
      expected_finance_version: financeVersion,
    },
    holder,
  );
  const reloadedRefunds = await request(collection, 'GET', undefined, bearer(owner));
  assert.equal(reloadedRefunds.status, 200);
  assert.equal(
    reloadedRefunds.body.data.items.find((item) => item.id === c.id).reversal_reason,
    reversalReason,
  );
  assert.equal(
    reloadedRefunds.body.data.items.find((item) => item.id === c.id).reason,
    'Hoàn phần dư',
  );
  const history = await request(
    `/api/v1/funds/${fundId}/history?limit=100`,
    'GET',
    undefined,
    bearer(holder),
  );
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal(
    history.body.data.items.find(
      (item) => item.action === 'REQUEST_REFUND_REVERSAL' && item.entity_id === c.id,
    ).reason,
    reversalReason,
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
      reason: reversalReason,
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
  await runIndependentRefundTests(h, helpers, mutate);
}

async function runIndependentRefundTests(h, helpers, mutate) {
  const { query, pass } = h;
  const { owner, holder, outsider } = h.actors;
  const { newTrip, write, enableBody } = helpers;
  for (const singleMember of [false, true]) {
    const tripId = await newTrip();
    if (singleMember)
      await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
        tripId,
        holder.id,
      ]);
    const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody(owner));
    assert.equal(enabled.status, 201, JSON.stringify(enabled.body));
    const fundId = enabled.body.data.id;
    const requestId = randomUUID(),
      contributionId = randomUUID();
    await query(
      'finance',
      `INSERT INTO contribution_requests(id,fund_id,title,amount_per_member,status,created_by_user_id)
      VALUES($1,$2,'Independent refund fixture',100000,'CLOSED',$3)`,
      [requestId, fundId, owner.id],
    );
    await query(
      'finance',
      `INSERT INTO contributions(id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version,confirmed_by_user_id,confirmed_at)
      VALUES($1,$2,$3,$4,100000,'CONFIRMED','{}',1,$4,now())`,
      [contributionId, requestId, fundId, owner.id],
    );
    await query(
      'finance',
      `INSERT INTO fund_transactions(fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,actor_user_id,business_key)
      VALUES($1,1,'IN','CONTRIBUTION',100000,100000,$2,$3,$4)`,
      [fundId, contributionId, owner.id, `fixture:${contributionId}`],
    );
    const seeded = (
      await query(
        'finance',
        'UPDATE funds SET current_balance=100000,finance_version=finance_version+1 WHERE id=$1 RETURNING finance_version',
        [fundId],
      )
    )[0];
    let result = await mutate(
      `/api/v1/funds/${fundId}/refunds`,
      {
        member_user_id: owner.id,
        amount: '100000',
        reason: 'Owner/Holder refund',
        expected_finance_version: seeded.finance_version,
      },
      owner,
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    let refund = result.body.data;
    const action = async (name, user, extra = {}, key = randomUUID()) => {
      const body = {
        expected_version: refund.version,
        expected_finance_version: refund.finance_version,
        ...extra,
      };
      const response = await mutate(`/api/v1/refunds/${refund.id}/${name}`, body, user, key);
      if (response.status === 200) refund = response.body.data;
      return { response, body, key };
    };
    assert.equal((await action('report-paid', owner)).response.status, 200);
    if (!singleMember) {
      assert.equal((await action('confirm-received', owner)).response.status, 409);
      assert.equal(
        (await action('assign-verifier', holder, { verifier_user_id: holder.id })).response.status,
        403,
      );
      assert.equal(
        (await action('assign-verifier', owner, { verifier_user_id: owner.id })).response.status,
        409,
      );
      assert.equal(
        (await action('assign-verifier', owner, { verifier_user_id: outsider.id })).response.status,
        409,
      );
      const assignment = await action('assign-verifier', owner, { verifier_user_id: holder.id });
      assert.equal(assignment.response.status, 200, JSON.stringify(assignment.response.body));
      assert.equal(refund.verifier_user_id, holder.id);
      assert.equal(refund.verifier_assigned_by_user_id, owner.id);
      const assignmentReplay = await mutate(
        `/api/v1/refunds/${refund.id}/assign-verifier`,
        assignment.body,
        owner,
        assignment.key,
      );
      assert.deepEqual(assignmentReplay.body.data, refund);
      const stale = await mutate(
        `/api/v1/refunds/${refund.id}/assign-verifier`,
        assignment.body,
        owner,
      );
      assert.equal(stale.status, 409);
      assert.equal((await action('confirm-received', owner)).response.status, 403);
      // A verifier that left loses authority immediately; a different current
      // Member can be appointed without inheriting the stale assignment.
      await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
        tripId,
        holder.id,
      ]);
      await query(
        'trip',
        "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
        [tripId, outsider.id],
      );
      const departed = (await action('confirm-received', holder)).response;
      assert.ok([403, 404].includes(departed.status), JSON.stringify(departed.body));
      assert.equal((await action('confirm-received', owner)).response.status, 409);
      assert.equal(
        (await action('assign-verifier', owner, { verifier_user_id: outsider.id })).response.status,
        200,
      );
      assert.equal((await action('confirm-received', outsider)).response.status, 200);
      assert.equal(refund.confirmation_mode, 'ASSIGNED_MEMBER');
      assert.equal(refund.independent_verification, true);
      assert.equal(refund.confirmed_by_user_id, outsider.id);
    } else {
      assert.equal((await action('confirm-received', owner)).response.status, 200);
      assert.equal(refund.confirmation_mode, 'SELF_UNVERIFIED');
      assert.equal(refund.independent_verification, false);
      assert.equal(refund.confirmed_by_user_id, owner.id);
    }
    const saved = (
      await query(
        'finance',
        'SELECT confirmation_mode,independent_verification FROM fund_refunds WHERE id=$1',
        [refund.id],
      )
    )[0];
    assert.equal(saved.confirmation_mode, refund.confirmation_mode);
    assert.equal(saved.independent_verification, refund.independent_verification);
    assert.equal(
      (
        await query(
          'finance',
          "SELECT count(*)::int n FROM fund_transactions WHERE fund_id=$1 AND transaction_type='REFUND'",
          [fundId],
        )
      )[0].n,
      1,
    );
    assert.equal(
      (await query('finance', 'SELECT current_balance::text FROM funds WHERE id=$1', [fundId]))[0]
        .current_balance,
      '0',
    );
    pass(
      singleMember
        ? 'Single-member refund explicitly records no independent verification'
        : 'Owner/Holder refund requires a current assigned independent Member; stale or departed assignments cannot confirm',
    );
  }
}
