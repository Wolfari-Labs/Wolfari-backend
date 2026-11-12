import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  PaymentRepository,
} = require('../apps/finance-service/dist/repositories/payment.repository.js');

export async function runHandoverTests(h, helpers) {
  const { request, query, transaction, bearer, waitFor, pass } = h;
  const { owner, holder, outsider } = h.actors;
  const { newTrip, write, enableBody, repo, tripClient, fundCommandHash } = helpers;
  const mutate = async (path, body, user = owner, key = randomUUID(), method = 'POST') => {
    const invoke = () => request(path, method, body, { ...bearer(user), 'idempotency-key': key });
    const first = await invoke();
    if (first.status !== 202) return first;
    await waitFor(async () => {
      const r = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
      return r.status === 200 && ['SUCCEEDED', 'FAILED'].includes(r.body.data.state);
    });
    return invoke();
  };
  const tripId = await newTrip();
  const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody());
  assert.equal(enabled.status, 201);
  const fundId = enabled.body.data.id,
    collection = `/api/v1/funds/${fundId}/holder-handovers`;
  const getFund = async () => {
    const r = await request(`/api/v1/trips/${tripId}/fund`, 'GET', undefined, bearer(owner));
    assert.equal(r.status, 200);
    return r.body.data;
  };
  const get = async (id, user = owner) =>
    request(`/api/v1/holder-handovers/${id}`, 'GET', undefined, bearer(user));
  const action = (row, name, user, extra = {}, key = randomUUID()) =>
    mutate(
      `/api/v1/holder-handovers/${row.id}/${name}`,
      { expected_version: row.version, expected_finance_version: row.finance_version, ...extra },
      user,
      key,
    );
  const createBody = {
    new_holder_user_id: owner.id,
    expected_finance_version: enabled.body.data.finance_version,
  };
  assert.equal((await request(collection, 'POST', createBody, bearer(owner))).status, 400);
  assert.equal((await mutate(collection, createBody, holder)).status, 403);
  assert([403, 404].includes((await mutate(collection, createBody, outsider)).status));
  assert.equal(
    (await mutate(collection, { ...createBody, new_holder_user_id: holder.id })).status,
    409,
  );
  assert.equal(
    (await mutate(collection, { ...createBody, new_holder_user_id: outsider.id })).status,
    409,
  );
  pass('Handover create requires Owner, active distinct successor and idempotency key');
  const createKey = randomUUID(),
    created = await mutate(collection, createBody, owner, createKey);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let row = created.body.data;
  assert.equal(row.status, 'NOMINATED');
  assert.equal(row.snapshot, null);
  const replay = await mutate(collection, createBody, owner, createKey);
  assert.deepEqual(replay.body.data, row);
  assert.equal((await mutate(collection, createBody)).status, 409);
  assert.equal(
    (
      await query(
        'finance',
        "SELECT count(*)::int n FROM fund_holder_handovers WHERE fund_id=$1 AND status IN ('NOMINATED','ACCEPTED')",
        [fundId],
      )
    )[0].n,
    1,
  );
  assert([403, 404].includes((await get(row.id, outsider)).status));
  assert(
    [403, 404].includes((await request(collection, 'GET', undefined, bearer(outsider))).status),
  );
  pass('Handover single active workflow, exact replay, outsider read masking');
  assert.equal(
    (
      await mutate(`/api/v1/funds/${fundId}/closures`, {
        expected_finance_version: row.finance_version,
      })
    ).status,
    409,
  );
  assert.equal((await action(row, 'accept', holder)).status, 403);
  assert.equal(
    (await action(row, 'confirm', holder, { expected_snapshot_finance_version: 1 })).status,
    409,
  );
  const accepted = await action(row, 'accept', owner);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  row = accepted.body.data;
  assert.equal(row.status, 'ACCEPTED');
  assert.equal(row.snapshot.current_balance, '0');
  assert.equal(row.snapshot.reserved_refund, '0');
  assert.match(row.snapshot.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await getFund()).holder_user_id, holder.id);
  pass('Only nominated successor accepts; accepted snapshot retains old Holder and blocks closure');
  const expense = {
    title: 'Forbidden new obligation',
    amount: '100',
    category: 'Test',
    paid_at: '2026-11-12T03:00:00Z',
    payment_method: 'CASH',
    expected_finance_version: row.finance_version,
  };
  assert.equal((await mutate(`/api/v1/funds/${fundId}/expenses`, expense, holder)).status, 409);
  assert.equal(
    (
      await query('finance', 'SELECT count(*)::int n FROM fund_expenses WHERE fund_id=$1', [fundId])
    )[0].n,
    0,
  );
  pass('Accepted handover blocks new expense obligations without creating rows');
  const firstConfirm = await action(row, 'confirm', holder, {
    expected_snapshot_finance_version: row.snapshot_finance_version,
  });
  assert.equal(firstConfirm.status, 200, JSON.stringify(firstConfirm.body));
  row = firstConfirm.body.data;
  assert(row.old_holder_confirmed_at);
  assert.equal(row.new_holder_confirmed_at, null);
  assert.equal((await getFund()).holder_user_id, holder.id);
  assert.equal(
    (
      await action(row, 'confirm', holder, {
        expected_snapshot_finance_version: row.snapshot_finance_version,
      })
    ).status,
    409,
  );
  const budget = await mutate(
    `/api/v1/funds/${fundId}/budget`,
    { budget_amount: '100000', expected_finance_version: row.finance_version },
    owner,
    randomUUID(),
    'PATCH',
  );
  assert.equal(budget.status, 200, JSON.stringify(budget.body));
  row = (await get(row.id)).body.data;
  assert.equal(row.snapshot_stale, true);
  assert.equal(row.old_holder_confirmed_at, null);
  assert.equal(row.new_holder_confirmed_at, null);
  assert.equal(
    (
      await action(row, 'confirm', owner, {
        expected_snapshot_finance_version: row.snapshot_finance_version,
      })
    ).status,
    409,
  );
  const refreshed = await action(row, 'refresh-snapshot', owner);
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  row = refreshed.body.data;
  assert.equal(row.snapshot_stale, false);
  assert.equal(row.old_holder_confirmed_at, null);
  assert.equal(row.snapshot_finance_version, budget.body.data.finance_version);
  pass(
    'Changed finance version invalidates old confirmations; explicit refresh captures new snapshot',
  );
  // Pending provider transitions can change without a Fund version increment. They must still invalidate consent.
  const requestId = randomUUID(),
    contributionId = randomUUID(),
    attemptId = randomUUID();
  await query(
    'finance',
    `INSERT INTO contribution_requests(id,fund_id,title,amount_per_member,status,created_by_user_id) VALUES($1,$2,'Handover pending fixture',100,'OPEN',$3)`,
    [requestId, fundId, owner.id],
  );
  await query(
    'finance',
    `INSERT INTO contributions(id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version) VALUES($1,$2,$3,$4,100,'PENDING','{}',1)`,
    [contributionId, requestId, fundId, owner.id],
  );
  await query(
    'finance',
    `INSERT INTO payment_attempts(id,contribution_id,provider,environment,amount,client_request_id,status,merchant_id,provider_order_id,destination_snapshot) VALUES($1,$2,'MOMO_SANDBOX','SANDBOX',100,$3,'CREATED','handover-fixture',$3,'{}')`,
    [attemptId, contributionId, randomUUID()],
  );
  row = (await get(row.id)).body.data;
  assert.equal(row.snapshot_stale, true);
  row = (await action(row, 'refresh-snapshot', owner)).body.data;
  assert(row.snapshot.pending_payment_ids.includes(attemptId));
  assert(row.snapshot.pending_contribution_ids.includes(contributionId));
  row = (
    await action(row, 'confirm', holder, {
      expected_snapshot_finance_version: row.snapshot_finance_version,
    })
  ).body.data;
  await query(
    'finance',
    "UPDATE payment_attempts SET status='PENDING',updated_at=clock_timestamp() WHERE id=$1",
    [attemptId],
  );
  row = (await get(row.id)).body.data;
  assert.equal(row.snapshot_stale, true);
  assert.equal(row.old_holder_confirmed_at, null);
  assert.equal(
    (
      await action(row, 'confirm', owner, {
        expected_snapshot_finance_version: row.snapshot_finance_version,
      })
    ).status,
    409,
  );
  row = (await action(row, 'refresh-snapshot', owner)).body.data;
  pass('Snapshot fingerprint detects unversioned provider state and retains pending liabilities');
  const payments = new PaymentRepository(helpers.financeDb);
  async function assertWriterUsesFundLock(label, work) {
    await query(
      'finance',
      `UPDATE payment_attempts SET status='PENDING',needs_reconciliation=false,provider_payload='{"phase":"CREATE_DISPATCH"}',updated_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
      [attemptId],
    );
    let release, announce;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const locked = new Promise((resolve) => {
      announce = resolve;
    });
    const blocking = transaction('finance', async (client) => {
      await client.query('SELECT id FROM funds WHERE id=$1 FOR UPDATE', [fundId]);
      announce();
      await gate;
    });
    await locked;
    let finished = false;
    const writing = work().then(() => {
      finished = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(finished, false, `${label} bypassed Fund lock`);
    } finally {
      release();
    }
    await Promise.all([blocking, writing]);
  }
  await assertWriterUsesFundLock('failDispatch', () => payments.failDispatch(attemptId));
  await assertWriterUsesFundLock('completeDispatch', () =>
    payments.completeDispatch(attemptId, { resultCode: 0, responseTime: Date.now() }),
  );
  await assertWriterUsesFundLock('markStaleDispatches', () => payments.markStaleDispatches());
  row = (await get(row.id)).body.data;
  assert.equal(row.snapshot_stale, true);
  row = (await action(row, 'refresh-snapshot', owner)).body.data;
  pass(
    'Provider dispatch completion, failure and timeout serialize with the same Fund snapshot lock',
  );
  const secondParty = await action(row, 'confirm', owner, {
    expected_snapshot_finance_version: row.snapshot_finance_version,
  });
  assert.equal(secondParty.status, 200, JSON.stringify(secondParty.body));
  row = secondParty.body.data;
  assert.equal(row.status, 'ACCEPTED');
  assert.equal(row.old_holder_confirmed_at, null);
  assert(row.new_holder_confirmed_at);
  const finalKey = randomUUID(),
    finalBody = {
      expected_version: row.version,
      expected_finance_version: row.finance_version,
      expected_snapshot_finance_version: row.snapshot_finance_version,
    };
  const finalized = await mutate(
    `/api/v1/holder-handovers/${row.id}/confirm`,
    finalBody,
    holder,
    finalKey,
  );
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  row = finalized.body.data;
  assert.equal(row.status, 'COMPLETED');
  assert(row.old_holder_confirmed_at && row.new_holder_confirmed_at && row.completed_at);
  const after = await getFund();
  assert.equal(after.holder_user_id, owner.id);
  assert.equal(after.finance_version, row.snapshot_finance_version + 1);
  assert.equal(after.current_balance, '0');
  assert.equal(
    (
      await query('finance', 'SELECT count(*)::int n FROM fund_transactions WHERE fund_id=$1', [
        fundId,
      ])
    )[0].n,
    0,
  );
  const destinations = await query(
    'finance',
    'SELECT active,is_default,confirmed_by_holder_at FROM payment_destinations WHERE fund_id=$1',
    [fundId],
  );
  assert(
    destinations.length > 0 &&
      destinations.every((x) => !x.active && !x.is_default && x.confirmed_by_holder_at === null),
  );
  const finalReplay = await mutate(
    `/api/v1/holder-handovers/${row.id}/confirm`,
    finalBody,
    holder,
    finalKey,
  );
  assert.deepEqual(finalReplay.body.data, row);
  assert.equal((await getFund()).finance_version, after.finance_version);
  pass(
    'Both parties atomically transfer Holder once; destinations reset, ledger unchanged and replay succeeds for former Holder',
  );
  const cancelled = await mutate(collection, {
    new_holder_user_id: holder.id,
    expected_finance_version: after.finance_version,
  });
  assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
  let next = cancelled.body.data;
  const cancel = await action(next, 'cancel', holder, { reason: 'Không tiếp nhận lúc này' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.data.status, 'CANCELLED');
  assert.equal((await getFund()).holder_user_id, owner.id);
  assert.equal((await action(cancel.body.data, 'accept', holder)).status, 409);
  pass('Cancellation preserves current Holder and terminal workflow cannot reopen');
  // Actual recovery: commit Finance side without acknowledging the Trip operation, then let recovery reconcile it.
  const recoveryTrip = await newTrip(),
    recoveryFund = (await write(`/api/v1/trips/${recoveryTrip}/fund`, enableBody())).body.data;
  const command = {
    scope: 'CREATE_HOLDER_HANDOVER',
    actor: owner.id,
    tripId: recoveryTrip,
    fundId: recoveryFund.id,
    body: { newHolderUserId: owner.id, expectedFinanceVersion: recoveryFund.finance_version },
  };
  const recoveryId = randomUUID(),
    input = { ...command, operationId: recoveryId, hash: fundCommandHash(command) };
  const guard = await tripClient.call(
    'BeginFinanceOperation',
    {
      operation_id: recoveryId,
      trip_id: recoveryTrip,
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
  await waitFor(async () => {
    const r = await request(`/api/v1/operations/${recoveryId}`, 'GET', undefined, bearer(owner));
    return r.status === 200 && r.body.data.state === 'SUCCEEDED';
  });
  const recovered = await mutate(
    `/api/v1/funds/${recoveryFund.id}/holder-handovers`,
    { new_holder_user_id: owner.id, expected_finance_version: recoveryFund.finance_version },
    owner,
    recoveryId,
  );
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.equal(
    (
      await query('finance', 'SELECT count(*)::int n FROM fund_holder_handovers WHERE fund_id=$1', [
        recoveryFund.id,
      ])
    )[0].n,
    1,
  );
  pass(
    'Committed handover command recovers after missing Trip completion without duplicate nomination',
  );
}
