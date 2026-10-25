import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FinanceClient } = require('../apps/api-gateway/dist/finance-client.js');

/** Fixture SQL only, in the isolated finance:test database. No business ledger writer is implied. */
export async function runFinanceLedgerTests(h) {
  const { request, query, transaction, bearer, tripBody, pass, actors, whileTripStopped } = h;
  const { owner, holder, member, outsider } = actors;
  const makeFund = async (user) => {
    const trip = await request(
      '/api/v1/trips',
      'POST',
      tripBody('Ledger read fixture'),
      bearer(user),
    );
    assert.equal(trip.status, 201);
    const tripId = trip.body.data.id;
    const [fund] = await query(
      'finance',
      'INSERT INTO funds(trip_id,holder_user_id) VALUES($1,$2) RETURNING id',
      [tripId, user === owner ? holder.id : user.id],
    );
    return { tripId, fundId: fund.id, path: `/api/v1/funds/${fund.id}/transactions` };
  };
  const f = await makeFund(owner),
    empty = await makeFund(owner),
    other = await makeFund(outsider);
  for (const user of [holder, member])
    await query(
      'trip',
      "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
      [f.tripId, user.id],
    );
  const get = (suffix = '', user = owner, path = f.path) =>
    request(`${path}${suffix}`, 'GET', undefined, bearer(user));
  assert.deepEqual((await get('', owner, empty.path)).body.data, { items: [], next_cursor: null });
  assert.equal((await get('', owner, `/api/v1/funds/${randomUUID()}/transactions`)).status, 404);
  assert.equal((await get('', owner, other.path)).status, 404);
  assert.equal((await get('', outsider)).status, 404);
  assert.equal((await request(f.path)).status, 401);
  assert.equal(
    (await request(f.path, 'GET', undefined, { authorization: 'Bearer invalid' })).status,
    401,
  );
  assert.equal((await request(f.path, 'POST', {}, bearer(owner))).status, 404);
  pass(
    'API077 distinguishes missing Fund from empty ledger; requires a session and current Trip membership',
  );

  const amount = '9007199254740993',
    base = 9007199254740993n;
  const stamp = '2026-10-15T00:00:00.000Z';
  const privateValue = 'PRIVATE_LEDGER_STORAGE_ONLY';
  let expenseId, contributionId, refundId, originalId;
  await transaction('finance', async (client) => {
    const q = async (sql, args) => (await client.query(sql, args)).rows[0];
    const req = await q(
      'INSERT INTO contribution_requests(fund_id,title,created_by_user_id) VALUES($1,$2,$3) RETURNING id',
      [f.fundId, 'Ledger fixture', owner.id],
    );
    contributionId = (
      await q(
        `INSERT INTO contributions(request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version,transfer_evidence_object_key)
      VALUES($1,$2,$3,$4,'CONFIRMED',$5::jsonb,1,$6) RETURNING id`,
        [
          req.id,
          f.fundId,
          member.id,
          amount,
          JSON.stringify({ private: privateValue }),
          privateValue,
        ],
      )
    ).id;
    expenseId = (
      await q(
        `INSERT INTO fund_expenses(fund_id,title,amount,status,created_by_user_id,receipt_object_key)
      VALUES($1,'Ledger expense',10,'CONFIRMED',$2,$3) RETURNING id`,
        [f.fundId, owner.id, privateValue],
      )
    ).id;
    refundId = (
      await q(
        `INSERT INTO fund_refunds(fund_id,member_user_id,amount,status,reason,requested_by_user_id)
      VALUES($1,$2,10,'CONFIRMED','Ledger refund',$3) RETURNING id`,
        [f.fundId, member.id, owner.id],
      )
    ).id;
    const entries = [
      ['CONTRIBUTION', 'IN', amount, amount, contributionId, null, null],
      ['EXPENSE', 'OUT', '10', (BigInt(amount) - 10n).toString(), null, expenseId, null],
      ['REFUND', 'OUT', '10', (BigInt(amount) - 20n).toString(), null, null, refundId],
    ];
    for (const [index, values] of entries.entries()) {
      const row = await q(
        `INSERT INTO fund_transactions(fund_id,sequence,transaction_type,direction,amount,balance_after,
        contribution_id,expense_id,refund_id,actor_user_id,business_key,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          f.fundId,
          (base + BigInt(index)).toString(),
          ...values,
          owner.id,
          `${privateValue}:${randomUUID()}`,
          stamp,
        ],
      );
      if (index === 1) originalId = row.id;
    }
    await q(
      `INSERT INTO fund_transactions(fund_id,sequence,transaction_type,direction,amount,balance_after,reversal_of_id,reason,business_key,created_at)
      VALUES($1,$2,'REVERSAL','IN',10,$3,$4,'Correct expense',$5,$6)`,
      [
        f.fundId,
        (base + 3n).toString(),
        (BigInt(amount) - 10n).toString(),
        originalId,
        `${privateValue}:${randomUUID()}`,
        stamp,
      ],
    );
    await q('UPDATE funds SET current_balance=$2 WHERE id=$1', [
      f.fundId,
      (BigInt(amount) - 10n).toString(),
    ]);
  });
  for (const user of [owner, holder, member]) {
    const response = await get('', user);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const rows = response.body.data.items;
    assert.deepEqual(
      rows.map((r) => r.transaction_type),
      ['REVERSAL', 'REFUND', 'EXPENSE', 'CONTRIBUTION'],
    );
    assert.deepEqual(
      rows.map((r) => r.direction),
      ['IN', 'OUT', 'OUT', 'IN'],
    );
    assert.equal(rows[0].reversal_of_id, originalId);
    assert.equal(rows[0].actor_user_id, null);
    assert.equal(rows[3].amount, amount);
    assert.equal(rows[3].balance_after, amount);
    assert.equal(rows[3].sequence, base.toString());
    assert.equal(rows[3].created_at, stamp);
    assert.equal(rows[3].reason, null);
    assert.equal(rows[3].contribution_id, contributionId);
    assert.equal(rows[2].expense_id, expenseId);
    assert.equal(rows[1].refund_id, refundId);
    assert.equal(response.body.data.next_cursor, null);
    assert(!JSON.stringify(response.body).includes(privateValue));
    assert(!JSON.stringify(response.body).includes('business_key'));
  }
  pass(
    'API077 returns exact int64 amounts/sequences and separate reversal history to Owner/Holder/Member without private storage fields',
  );

  for (const suffix of [
    '?limit=0',
    '?limit=101',
    '?limit=1.5',
    '?limit=',
    '?limit=1%0A',
    '?limit=1&limit=2',
    '?sort=asc',
    '?actor_user_id=x',
    '?cursor=',
    '?cursor=!',
    '?cursor=a&cursor=b',
    `?cursor=${'a'.repeat(513)}`,
    `?cursor=${Buffer.from(JSON.stringify([1, f.fundId, '1 OR true'])).toString('base64url')}`,
  ])
    assert.equal((await get(suffix)).status, 400, suffix);
  assert.equal((await get('?limit=100')).body.data.items.length, 4);
  assert.equal((await get('?limit=1')).body.data.items.length, 1);
  const first = (await get('?limit=2', member)).body.data;
  assert(first.next_cursor);
  assert.equal((await get(`?cursor=${first.next_cursor}`, owner, empty.path)).status, 400);
  pass(
    'API077 validates bounded pagination, duplicate/unknown queries and Fund-scoped opaque cursors',
  );

  // Add a newer entry between pages. The next page must continue below the old last sequence.
  await transaction('finance', async (client) => {
    const refund = (
      await client.query(
        `INSERT INTO fund_refunds(fund_id,member_user_id,amount,status,reason,requested_by_user_id)
      VALUES($1,$2,1,'CONFIRMED','new append',$3) RETURNING id`,
        [f.fundId, member.id, owner.id],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO fund_transactions(fund_id,sequence,transaction_type,direction,amount,balance_after,refund_id,business_key)
      VALUES($1,9223372036854775807,'REFUND','OUT',1,$2,$3,$4)`,
      [f.fundId, (BigInt(amount) - 11n).toString(), refund.id, `${privateValue}:${randomUUID()}`],
    );
    await client.query('UPDATE funds SET current_balance=$2 WHERE id=$1', [
      f.fundId,
      (BigInt(amount) - 11n).toString(),
    ]);
  });
  const second = (await get(`?limit=2&cursor=${first.next_cursor}`, member)).body.data;
  assert.deepEqual(
    second.items.map((r) => r.sequence),
    [(base + 1n).toString(), base.toString()],
  );
  assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((r) => r.id)).size, 4);
  assert.equal((await get()).body.data.items[0].sequence, '9223372036854775807');
  await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
    f.tripId,
    member.id,
  ]);
  assert.equal((await get(`?cursor=${first.next_cursor}`, member)).status, 404);
  pass(
    'API077 continuation excludes newer appends without duplication and rechecks membership on every page',
  );

  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [f.tripId]);
  for (const state of ['CLOSING', 'CLOSED']) {
    await query('finance', 'UPDATE funds SET status=$2 WHERE id=$1', [f.fundId, state]);
    assert.equal((await get('', holder)).status, 200);
  }
  await query('trip', 'UPDATE trips SET deleted_at=now() WHERE id=$1', [f.tripId]);
  assert.equal((await get()).status, 404);
  await query('trip', 'UPDATE trips SET deleted_at=NULL WHERE id=$1', [f.tripId]);
  pass('API077 permits archived/closed history for active members but hides deleted Trips');

  const direct = new FinanceClient(h.financeTarget, h.financeSecret);
  const wrong = new FinanceClient(h.financeTarget, 'x'.repeat(64));
  try {
    const rpc = await direct.call(
      'ListFundTransactions',
      { fund_id: f.fundId, actor_user_id: owner.id },
      randomUUID(),
    );
    assert.equal(rpc.items.length, 5);
    assert(!JSON.stringify(rpc).includes(privateValue));
    for (const input of [{ limit: 0 }, { cursor: '' }])
      await assert.rejects(
        () =>
          direct.call(
            'ListFundTransactions',
            { fund_id: f.fundId, actor_user_id: owner.id, ...input },
            randomUUID(),
          ),
        (error) => error.code === 3,
      );
    await assert.rejects(
      () =>
        wrong.call(
          'ListFundTransactions',
          { fund_id: f.fundId, actor_user_id: owner.id },
          randomUUID(),
        ),
      (error) => error.code === 7,
    );
  } finally {
    direct.close();
    wrong.close();
  }
  await whileTripStopped(async () => {
    const response = await get();
    assert.equal(response.status, 503);
    assert.equal(response.body.error.retryable, true);
    assert(!('data' in response.body));
  });
  // HTTP readiness of the restarted process does not mean the existing gRPC subchannel
  // has reconnected yet. Establish a successful read before testing an unrelated SQL fault.
  await h.waitFor(async () => (await get()).status === 200);
  // Isolated fixture fault: hide only the ledger table, then restore it even on assertion failure.
  await query('finance', 'ALTER TABLE fund_transactions RENAME TO ledger_read_fault_fixture');
  try {
    const response = await get();
    assert.equal(response.status, 503);
    assert(!('data' in response.body));
  } finally {
    await query('finance', 'ALTER TABLE ledger_read_fault_fixture RENAME TO fund_transactions');
  }
  assert.equal((await get()).status, 200);
  pass(
    'API077 rejects unauthorized gRPC callers and returns retryable errors on Trip or SQL failure, never a fake empty page',
  );

  const snapshot = async () => {
    const result = {};
    for (const table of [
      'funds',
      'fund_transactions',
      'command_receipts',
      'finance_audit_logs',
      'outbox_events',
    ])
      result[table] = (
        await query(
          'finance',
          `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`,
        )
      )[0].rows;
    return result;
  };
  const before = await snapshot();
  await get();
  await get('?limit=1');
  await get(`?cursor=${first.next_cursor}`);
  assert.deepEqual(await snapshot(), before);
  pass('API077 reads preserve Fund balance/version, ledger, receipts, audit and outbox exactly');
  return { forbidden: [privateValue] };
}
