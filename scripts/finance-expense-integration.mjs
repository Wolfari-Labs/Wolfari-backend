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
}
