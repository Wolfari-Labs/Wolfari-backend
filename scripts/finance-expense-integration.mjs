import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/finance-service/package.json', import.meta.url));
const sharp = require('sharp');

export async function runExpenseDraftTests(h, helpers) {
  const { request, query, bearer, waitFor, pass } = h;
  const { owner, holder, outsider } = h.actors;
  const { newTrip, write, enableBody } = helpers;
  const mutate = async (path, method, body, user, key = randomUUID()) => {
    const headers = { ...bearer(user), 'idempotency-key': key };
    const first = await request(path, method, body, headers);
    if (first.status !== 202) return first;
    assert.equal(first.body.data.operation_id, key);
    await waitFor(async () => {
      const polled = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
      assert.equal(polled.status, 200);
      return ['SUCCEEDED', 'FAILED'].includes(polled.body.data.state);
    });
    return request(path, method, body, headers);
  };

  const tripId = await newTrip();
  const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody());
  assert.equal(enabled.status, 201);
  const fundId = enabled.body.data.id;
  let financeVersion = enabled.body.data.finance_version;
  const collection = `/api/v1/funds/${fundId}/expenses`;
  const receiptPath = `/api/v1/funds/${fundId}/receipts`;
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'blue' },
  })
    .png()
    .toBuffer();
  const uploadReceipt = async (user) => {
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'expense.png');
    const response = await fetch(h.gatewayUrl + receiptPath, {
      method: 'POST',
      headers: bearer(user),
      body: form,
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body.data.object_key;
  };
  const downloadReceipt = (key, user) =>
    fetch(`${h.gatewayUrl}${receiptPath}/download?object_key=${encodeURIComponent(key)}`, {
      headers: bearer(user),
    });
  const firstReceipt = await uploadReceipt(holder);

  const createBody = {
    title: 'Taxi sân bay',
    description: 'Chi chung của nhóm',
    amount: '9007199254740993',
    category: 'Di chuyển',
    paid_at: '2026-10-22T10:15:30+07:00',
    payment_method: 'CASH',
    receipt_object_key: firstReceipt,
    expected_finance_version: financeVersion,
  };
  const createWithoutReceipt = { ...createBody };
  delete createWithoutReceipt.receipt_object_key;
  assert.equal((await request(collection, 'POST', createBody, bearer(holder))).status, 400);
  assert(
    [403, 404].includes((await mutate(collection, 'POST', createWithoutReceipt, outsider)).status),
  );
  const createKey = randomUUID();
  const created = await mutate(collection, 'POST', createBody, holder, createKey);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.amount, '9007199254740993');
  assert.equal(created.body.data.status, 'DRAFT');
  assert.equal(created.body.data.created_by_user_id, holder.id);
  assert.equal(created.body.data.receipt_available, true);
  assert.equal(Object.hasOwn(created.body.data, 'receipt_object_key'), false);
  assert.equal((await downloadReceipt(firstReceipt, owner)).status, 200);
  const expenseId = created.body.data.id;
  financeVersion = created.body.data.finance_version;

  const replay = await mutate(collection, 'POST', createBody, holder, createKey);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.id, expenseId);
  assert.equal(replay.body.data.finance_version, financeVersion);
  assert.equal(
    (await mutate(collection, 'POST', { ...createBody, title: 'Khác' }, holder, createKey)).status,
    409,
  );

  const item = `/api/v1/expenses/${expenseId}`;
  const noOp = await mutate(
    item,
    'PATCH',
    {
      title: 'Taxi sân bay',
      expected_version: 1,
      expected_finance_version: financeVersion,
    },
    owner,
  );
  assert.equal(noOp.status, 200);
  assert.equal(noOp.body.data.version, 1);
  assert.equal(noOp.body.data.finance_version, financeVersion);

  const replacementReceipt = await uploadReceipt(owner);
  const updated = await mutate(
    item,
    'PATCH',
    {
      description: null,
      amount: '250000',
      receipt_object_key: replacementReceipt,
      expected_version: 1,
      expected_finance_version: financeVersion,
    },
    owner,
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.description, null);
  assert.equal(updated.body.data.amount, '250000');
  assert.equal(updated.body.data.receipt_available, true);
  assert.equal(updated.body.data.version, 2);
  financeVersion = updated.body.data.finance_version;
  assert.equal((await downloadReceipt(firstReceipt, holder)).status, 200);
  assert.equal((await downloadReceipt(replacementReceipt, holder)).status, 200);
  assert.equal(
    (
      await mutate(
        item,
        'PATCH',
        { title: 'Stale', expected_version: 1, expected_finance_version: financeVersion },
        holder,
      )
    ).status,
    409,
  );

  const submitted = await mutate(
    `${item}/submit`,
    'POST',
    { expected_version: 2, expected_finance_version: financeVersion },
    owner,
  );
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.data.status, 'SUBMITTED');
  assert(submitted.body.data.submitted_at);
  financeVersion = submitted.body.data.finance_version;
  assert.equal(
    (
      await mutate(
        `${item}/withdraw`,
        'POST',
        { expected_version: 3, expected_finance_version: financeVersion },
        owner,
      )
    ).status,
    403,
  );
  const withdrawn = await mutate(
    `${item}/withdraw`,
    'POST',
    { expected_version: 3, expected_finance_version: financeVersion },
    holder,
  );
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.data.status, 'DRAFT');
  assert.equal(withdrawn.body.data.submitted_at, null);
  financeVersion = withdrawn.body.data.finance_version;

  const cleared = await mutate(
    item,
    'PATCH',
    {
      receipt_object_key: null,
      expected_version: 4,
      expected_finance_version: financeVersion,
    },
    holder,
  );
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.version, 5);
  assert.equal(cleared.body.data.receipt_available, false);
  financeVersion = cleared.body.data.finance_version;
  assert.equal((await downloadReceipt(firstReceipt, owner)).status, 200);
  assert.equal((await downloadReceipt(replacementReceipt, owner)).status, 200);

  const second = await mutate(
    collection,
    'POST',
    {
      title: 'Khách sạn',
      amount: '500000',
      expected_finance_version: financeVersion,
    },
    owner,
  );
  assert.equal(second.status, 201);
  financeVersion = second.body.data.finance_version;
  const firstPage = await request(
    `${collection}?limit=1&status=DRAFT`,
    'GET',
    undefined,
    bearer(holder),
  );
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.data.items.length, 1);
  assert(firstPage.body.data.next_cursor);
  const nextPage = await request(
    `${collection}?limit=1&status=DRAFT&cursor=${firstPage.body.data.next_cursor}`,
    'GET',
    undefined,
    bearer(holder),
  );
  assert.equal(nextPage.status, 200);
  assert.equal(nextPage.body.data.items.length, 1);
  assert.notEqual(nextPage.body.data.items[0].id, firstPage.body.data.items[0].id);
  assert.equal(
    (
      await request(
        `${collection}?limit=1&status=SUBMITTED&cursor=${firstPage.body.data.next_cursor}`,
        'GET',
        undefined,
        bearer(holder),
      )
    ).status,
    400,
  );

  const removed = await mutate(
    item,
    'DELETE',
    { expected_version: 5, expected_finance_version: financeVersion },
    owner,
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.state, 'SUCCEEDED');
  financeVersion += 1;
  assert.equal((await downloadReceipt(firstReceipt, owner)).status, 404);
  assert.equal((await downloadReceipt(replacementReceipt, owner)).status, 404);
  const list = await request(collection, 'GET', undefined, bearer(holder));
  assert.equal(list.status, 200);
  assert.equal(
    list.body.data.items.some((expense) => expense.id === expenseId),
    false,
  );

  const fund = (
    await query('finance', 'SELECT current_balance::text,finance_version FROM funds WHERE id=$1', [
      fundId,
    ])
  )[0];
  assert.equal(fund.current_balance, '0');
  assert.equal(fund.finance_version, financeVersion);
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM fund_transactions WHERE fund_id=$1', [
        fundId,
      ])
    )[0].n,
    '0',
  );
  const audit = await query(
    'finance',
    "SELECT action,actor_user_id FROM finance_audit_logs WHERE fund_id=$1 AND entity_type='Expense' ORDER BY occurred_at",
    [fundId],
  );
  assert(audit.some((row) => row.action === 'UPDATE_EXPENSE' && row.actor_user_id === owner.id));
  assert(audit.some((row) => row.action === 'WITHDRAW_EXPENSE' && row.actor_user_id === holder.id));
  pass(
    'Expense API096-101 enforces roles, replay, cursor, immutable receipt history and no-ledger behavior',
  );

  const requestId = randomUUID();
  const contributionId = randomUUID();
  await query(
    'finance',
    `INSERT INTO contribution_requests(id,fund_id,title,status,created_by_user_id)
     VALUES($1,$2,'Expense balance fixture','CLOSED',$3)`,
    [requestId, fundId, owner.id],
  );
  await query(
    'finance',
    `INSERT INTO contributions
     (id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,
      destination_version,confirmed_by_user_id,confirmed_at,self_contribution)
     VALUES($1,$2,$3,$4,600000,'CONFIRMED',$5::jsonb,1,$4,now(),true)`,
    [contributionId, requestId, fundId, holder.id, JSON.stringify({ type: 'TEST' })],
  );
  await query(
    'finance',
    `INSERT INTO fund_transactions
     (fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,
      actor_user_id,business_key)
     VALUES($1,1,'IN','CONTRIBUTION',600000,600000,$2,$3,$4)`,
    [fundId, contributionId, holder.id, `expense-fixture:${contributionId}`],
  );
  financeVersion = (
    await query(
      'finance',
      `UPDATE funds SET current_balance=600000,finance_version=finance_version+1,
       updated_at=clock_timestamp() WHERE id=$1 RETURNING finance_version`,
      [fundId],
    )
  )[0].finance_version;

  const secondId = second.body.data.id;
  const secondItem = `/api/v1/expenses/${secondId}`;
  const secondSubmitted = await mutate(
    `${secondItem}/submit`,
    'POST',
    { expected_version: 1, expected_finance_version: financeVersion },
    owner,
  );
  assert.equal(secondSubmitted.status, 200);
  financeVersion = secondSubmitted.body.data.finance_version;
  assert.equal(
    (
      await mutate(
        `${secondItem}/confirm`,
        'POST',
        {
          paid_at: '2026-10-22T14:15:30+07:00',
          payment_method: 'BANK_TRANSFER',
          expected_version: 2,
          expected_finance_version: financeVersion,
        },
        owner,
      )
    ).status,
    403,
  );
  const confirmKey = randomUUID();
  const confirmed = await mutate(
    `${secondItem}/confirm`,
    'POST',
    {
      paid_at: '2026-10-22T14:15:30+07:00',
      payment_method: 'BANK_TRANSFER',
      expected_version: 2,
      expected_finance_version: financeVersion,
    },
    holder,
    confirmKey,
  );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.status, 'CONFIRMED');
  assert.equal(confirmed.body.data.paid_by_user_id, holder.id);
  assert.equal(confirmed.body.data.confirmed_by_user_id, holder.id);
  assert.equal(confirmed.body.data.payment_method, 'BANK_TRANSFER');
  financeVersion = confirmed.body.data.finance_version;
  const confirmedReplay = await mutate(
    `${secondItem}/confirm`,
    'POST',
    {
      paid_at: '2026-10-22T14:15:30+07:00',
      payment_method: 'BANK_TRANSFER',
      expected_version: 2,
      expected_finance_version: financeVersion - 1,
    },
    holder,
    confirmKey,
  );
  assert.equal(confirmedReplay.status, 200);
  assert.equal(confirmedReplay.body.data.id, secondId);
  assert.equal(confirmedReplay.body.data.finance_version, financeVersion);
  let ledger = await query(
    'finance',
    `SELECT direction,transaction_type,amount::text,balance_after::text,expense_id,
            reversal_of_id,reason
     FROM fund_transactions WHERE fund_id=$1 ORDER BY sequence`,
    [fundId],
  );
  assert.deepEqual(ledger[1], {
    direction: 'OUT',
    transaction_type: 'EXPENSE',
    amount: '500000',
    balance_after: '100000',
    expense_id: secondId,
    reversal_of_id: null,
    reason: null,
  });

  const reversed = await mutate(
    `${secondItem}/reverse`,
    'POST',
    {
      reason: 'Merchant returned payment',
      expected_version: 3,
      expected_finance_version: financeVersion,
    },
    holder,
  );
  assert.equal(reversed.status, 200);
  assert.equal(reversed.body.data.status, 'REVERSED');
  assert.equal(reversed.body.data.receipt_available, second.body.data.receipt_available);
  assert.equal(reversed.body.data.paid_at, confirmed.body.data.paid_at);
  financeVersion = reversed.body.data.finance_version;
  assert.equal(
    (
      await mutate(
        `${secondItem}/reverse`,
        'POST',
        {
          reason: 'Again',
          expected_version: 4,
          expected_finance_version: financeVersion,
        },
        holder,
      )
    ).status,
    409,
  );
  ledger = await query(
    'finance',
    `SELECT id,direction,transaction_type,amount::text,balance_after::text,expense_id,
            reversal_of_id,reason
     FROM fund_transactions WHERE fund_id=$1 ORDER BY sequence`,
    [fundId],
  );
  assert.equal(ledger.length, 3);
  assert.equal(ledger[2].direction.trimEnd(), 'IN');
  assert.equal(ledger[2].transaction_type, 'REVERSAL');
  assert.equal(ledger[2].amount, '500000');
  assert.equal(ledger[2].balance_after, '600000');
  assert.equal(ledger[2].expense_id, null);
  assert.equal(ledger[2].reversal_of_id, ledger[1].id);
  assert.equal(ledger[2].reason, 'Merchant returned payment');

  const rejectedDraft = await mutate(
    collection,
    'POST',
    { title: 'Duplicate dinner', amount: '50000', expected_finance_version: financeVersion },
    owner,
  );
  assert.equal(rejectedDraft.status, 201);
  financeVersion = rejectedDraft.body.data.finance_version;
  const rejectedSubmitted = await mutate(
    `/api/v1/expenses/${rejectedDraft.body.data.id}/submit`,
    'POST',
    { expected_version: 1, expected_finance_version: financeVersion },
    owner,
  );
  assert.equal(rejectedSubmitted.status, 200);
  financeVersion = rejectedSubmitted.body.data.finance_version;
  const rejected = await mutate(
    `/api/v1/expenses/${rejectedDraft.body.data.id}/reject`,
    'POST',
    {
      reason: 'Duplicate request',
      expected_version: 2,
      expected_finance_version: financeVersion,
    },
    holder,
  );
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.status, 'REJECTED');
  assert.equal(rejected.body.data.rejected_reason, 'Duplicate request');
  financeVersion = rejected.body.data.finance_version;
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM fund_transactions WHERE fund_id=$1', [
        fundId,
      ])
    )[0].n,
    '3',
  );

  await query(
    'finance',
    `INSERT INTO fund_refunds
     (fund_id,member_user_id,amount,status,reason,requested_by_user_id)
     VALUES($1,$2,500000,'PENDING','Reserved for member',$3)`,
    [fundId, holder.id, owner.id],
  );
  financeVersion = (
    await query(
      'finance',
      `UPDATE funds SET finance_version=finance_version+1,updated_at=clock_timestamp()
       WHERE id=$1 RETURNING finance_version`,
      [fundId],
    )
  )[0].finance_version;
  const overspend = await mutate(
    collection,
    'POST',
    { title: 'Over available balance', amount: '150000', expected_finance_version: financeVersion },
    owner,
  );
  assert.equal(overspend.status, 201);
  financeVersion = overspend.body.data.finance_version;
  const overspendSubmitted = await mutate(
    `/api/v1/expenses/${overspend.body.data.id}/submit`,
    'POST',
    { expected_version: 1, expected_finance_version: financeVersion },
    owner,
  );
  assert.equal(overspendSubmitted.status, 200);
  financeVersion = overspendSubmitted.body.data.finance_version;
  assert.equal(
    (
      await mutate(
        `/api/v1/expenses/${overspend.body.data.id}/confirm`,
        'POST',
        {
          paid_at: '2026-10-22T15:00:00+07:00',
          payment_method: 'CASH',
          expected_version: 2,
          expected_finance_version: financeVersion,
        },
        holder,
      )
    ).status,
    409,
  );

  const concurrentDrafts = [];
  for (const title of ['Concurrent A', 'Concurrent B']) {
    const draft = await mutate(
      collection,
      'POST',
      { title, amount: '80000', expected_finance_version: financeVersion },
      owner,
    );
    assert.equal(draft.status, 201);
    financeVersion = draft.body.data.finance_version;
    concurrentDrafts.push(draft.body.data);
  }
  for (const draft of concurrentDrafts) {
    const submission = await mutate(
      `/api/v1/expenses/${draft.id}/submit`,
      'POST',
      { expected_version: 1, expected_finance_version: financeVersion },
      owner,
    );
    assert.equal(submission.status, 200);
    financeVersion = submission.body.data.finance_version;
  }
  const competing = await Promise.all(
    concurrentDrafts.map((draft) =>
      mutate(
        `/api/v1/expenses/${draft.id}/confirm`,
        'POST',
        {
          paid_at: '2026-10-22T16:00:00+07:00',
          payment_method: 'CASH',
          expected_version: 2,
          expected_finance_version: financeVersion,
        },
        holder,
      ),
    ),
  );
  assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
  const settledRows = await query(
    'finance',
    'SELECT status FROM fund_expenses WHERE id=ANY($1::uuid[]) ORDER BY status',
    [concurrentDrafts.map((draft) => draft.id)],
  );
  assert.deepEqual(
    settledRows.map((row) => row.status),
    ['CONFIRMED', 'SUBMITTED'],
  );
  const finalFund = (
    await query('finance', 'SELECT current_balance::text FROM funds WHERE id=$1', [fundId])
  )[0];
  assert.equal(finalFund.current_balance, '520000');
  assert.equal(
    (
      await query(
        'finance',
        `SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0)::text AS balance
         FROM fund_transactions WHERE fund_id=$1`,
        [fundId],
      )
    )[0].balance,
    finalFund.current_balance,
  );
  pass(
    'Expense API102-104 enforces Holder settlement, reservation, replay, linked reversal and concurrent balance safety',
  );
}
