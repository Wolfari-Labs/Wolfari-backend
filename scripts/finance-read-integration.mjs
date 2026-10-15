import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { FinanceClient } = require('../apps/api-gateway/dist/finance-client.js');

/** Runs only inside trip-integration --finance's isolated Compose project and real services. */
export async function runFinanceReadTests({
  request,
  query,
  account,
  bearer,
  tripBody,
  pass,
  financeTarget,
  financeSecret,
  whileTripStopped,
}) {
  const owner = await account('Finance Owner'),
    holder = await account('Finance Holder');
  const member = await account('Finance Member'),
    outsider = await account('Finance Outsider');
  const created = await request('/api/v1/trips', 'POST', tripBody('Finance reads'), bearer(owner));
  assert.equal(created.status, 201);
  const tripId = created.body.data.id,
    fundPath = `/api/v1/trips/${tripId}/fund`;
  for (const user of [holder, member])
    await query(
      'trip',
      "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
      [tripId, user.id],
    );
  assert.equal((await request(fundPath, 'GET', undefined, bearer(owner))).status, 404);
  pass('API071 authorizes a real Identity session and reports Fund not enabled');

  const [fund] = await query(
    'finance',
    `INSERT INTO funds(trip_id,holder_user_id,current_balance,budget_amount) VALUES($1,$2,9007199254740993,NULL) RETURNING id`,
    [tripId, holder.id],
  );
  const destinationsPath = `/api/v1/funds/${fund.id}/destinations`;
  const empty = await request(destinationsPath, 'GET', undefined, bearer(owner));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data, []);
  pass('API073 returns an empty list for an existing Fund');
  const [bank] = await query(
    'finance',
    `INSERT INTO payment_destinations(fund_id,destination_type,bank_code,account_number,account_name,is_default,active,confirmed_by_holder_at)
    VALUES($1,'VIETQR','TEST','000123','PRIVATE TEST HOLDER',true,true,now()) RETURNING id`,
    [fund.id],
  );
  await query(
    'finance',
    `INSERT INTO payment_destinations(fund_id,destination_type,momo_phone,is_default,active)
    VALUES($1,'MOMO_SANDBOX','000999',false,false)`,
    [fund.id],
  );

  for (const user of [owner, holder, member]) {
    const result = await request(fundPath, 'GET', undefined, bearer(user));
    assert.equal(result.status, 200);
    assert.equal(result.body.data.budget_amount, null);
    assert.equal(result.body.data.current_balance, '9007199254740993');
    assert.equal(result.body.data.available_balance, '9007199254740993');
    assert.equal(result.body.data.reserved_refund, '0');
    assert.equal(result.body.data.closed_at, null);
    assert(!JSON.stringify(result.body).includes('PRIVATE TEST HOLDER'));
  }
  await query('finance', 'UPDATE funds SET budget_amount=0 WHERE id=$1', [fund.id]);
  assert.equal(
    (await request(fundPath, 'GET', undefined, bearer(owner))).body.data.budget_amount,
    '0',
  );
  await query('finance', 'UPDATE funds SET budget_amount=9223372036854775807 WHERE id=$1', [
    fund.id,
  ]);
  assert.equal(
    (await request(fundPath, 'GET', undefined, bearer(owner))).body.data.budget_amount,
    '9223372036854775807',
  );
  pass('API071 preserves null/zero/int8 money through real SQL, protobuf and HTTP');

  for (const user of [owner, holder]) {
    const result = await request(destinationsPath, 'GET', undefined, bearer(user));
    assert.equal(result.status, 200);
    assert.equal(result.body.data.length, 2);
    const bankRow = result.body.data.find((row) => row.id === bank.id);
    assert.equal(bankRow.account_number, '000123');
    assert(bankRow.confirmed_by_holder_at);
    assert(!('momo_phone' in bankRow));
    const momo = result.body.data.find((row) => row.destination_type === 'MOMO_SANDBOX');
    assert.equal(momo.momo_phone, '000999');
    assert.equal(momo.active, false);
    assert.equal(momo.is_default, false);
    assert.equal(momo.confirmed_by_holder_at, null);
    assert(!('account_number' in momo));
  }
  const ordinary = await request(destinationsPath, 'GET', undefined, bearer(member));
  assert.equal(ordinary.status, 200);
  for (const row of ordinary.body.data)
    for (const key of ['bank_code', 'account_number', 'account_name', 'momo_phone'])
      assert(!(key in row));
  pass('API073 enforces Owner/Holder private fields and Member metadata on the real transport');

  const direct = new FinanceClient(financeTarget, financeSecret);
  const wrong = new FinanceClient(financeTarget, 'x'.repeat(64));
  try {
    const result = await direct.call(
      'ListPaymentDestinations',
      { fund_id: fund.id, actor_user_id: member.id },
      randomUUID(),
    );
    assert.equal(result.destinations.length, 2);
    assert(!JSON.stringify(result).includes('000123'));
    assert(!JSON.stringify(result).includes('PRIVATE TEST HOLDER'));
    await assert.rejects(
      () => wrong.call('GetFund', { trip_id: tripId, actor_user_id: owner.id }, randomUUID()),
      (error) => error.code === 7,
    );
  } finally {
    direct.close();
    wrong.close();
  }
  pass('Finance removes private fields before gRPC and denies an invalid service secret');

  for (const path of [fundPath, destinationsPath]) {
    assert.equal((await request(path, 'GET', undefined, bearer(outsider))).status, 404);
    assert.equal((await request(path)).status, 401);
    assert.equal(
      (await request(`${path}?actor_user_id=${owner.id}`, 'GET', undefined, bearer(member))).status,
      400,
    );
    assert.equal(
      (await request(path, 'GET', undefined, { authorization: 'Bearer invalid' })).status,
      401,
    );
  }
  assert.equal(
    (await request(`/api/v1/funds/${randomUUID()}/destinations`, 'GET', undefined, bearer(owner)))
      .status,
    404,
  );
  assert.equal(
    (await request('/api/v1/trips/invalid/fund', 'GET', undefined, bearer(owner))).status,
    400,
  );
  assert.equal((await request(destinationsPath, 'POST', {}, bearer(owner))).status, 400);
  assert.equal((await request(destinationsPath, 'DELETE', undefined, bearer(owner))).status, 404);
  pass(
    'HTTP denies nonmembers, forged query identity, invalid tokens/IDs, malformed writes and unsupported methods',
  );

  const other = await request(
    '/api/v1/trips',
    'POST',
    tripBody('Other Finance scope'),
    bearer(outsider),
  );
  assert.equal(other.status, 201);
  const [otherFund] = await query(
    'finance',
    'INSERT INTO funds(trip_id,holder_user_id) VALUES($1,$2) RETURNING id',
    [other.body.data.id, outsider.id],
  );
  assert.equal(
    (await request(`/api/v1/funds/${otherFund.id}/destinations`, 'GET', undefined, bearer(owner)))
      .status,
    404,
  );
  await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    member.id,
  ]);
  for (const path of [fundPath, destinationsPath])
    assert.equal((await request(path, 'GET', undefined, bearer(member))).status, 404);
  pass('No authorization cache: departed members and cross-Trip access are rejected');

  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [tripId]);
  await query(
    'finance',
    "UPDATE funds SET status='CLOSED',closed_at=now(),current_balance=0 WHERE id=$1",
    [fund.id],
  );
  const closed = await request(fundPath, 'GET', undefined, bearer(owner));
  assert.equal(closed.status, 200);
  assert.equal(closed.body.data.status, 'CLOSED');
  assert(closed.body.data.closed_at);
  assert.equal((await request(destinationsPath, 'GET', undefined, bearer(holder))).status, 200);
  pass('Archived Trip and CLOSED Fund remain readable to current members');

  await whileTripStopped(async () => {
    for (const path of [fundPath, destinationsPath]) {
      const result = await request(path, 'GET', undefined, bearer(owner));
      assert.equal(result.status, 503);
      assert.equal(result.body.error.retryable, true);
      assert(!('data' in result.body));
    }
  });
  pass('Trip unavailable produces retryable 503, never a successful or empty read');
  for (const table of [
    'command_receipts',
    'finance_audit_logs',
    'outbox_events',
    'fund_transactions',
  ]) {
    assert.equal(
      Number((await query('finance', `SELECT count(*) AS count FROM ${table}`))[0].count),
      0,
    );
  }
  pass('Reads create no receipts, audit mutations, events or ledger entries');
  return {
    actors: { owner, holder, member, outsider },
    forbidden: [
      owner.access,
      holder.access,
      member.access,
      outsider.access,
      'PRIVATE TEST HOLDER',
      '000123',
      '000999',
    ],
  };
}
