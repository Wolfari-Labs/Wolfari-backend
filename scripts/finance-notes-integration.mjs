import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runFinancialNoteTests(h, helpers) {
  const { request, query, bearer, waitFor, pass } = h;
  const { owner, holder, outsider } = h.actors;
  const { newTrip, write, enableBody } = helpers;
  const mutate = async (path, method, body, user, key = randomUUID()) => {
    const headers = { ...bearer(user), 'idempotency-key': key };
    const first = await request(path, method, body, headers);
    if (first.status !== 202) return first;
    await waitFor(async () => {
      const polled = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
      return polled.status === 200 && ['SUCCEEDED', 'FAILED'].includes(polled.body.data.state);
    });
    return request(path, method, body, headers);
  };
  const tripId = await newTrip();
  const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody());
  assert.equal(enabled.status, 201);
  const fundId = enabled.body.data.id;
  const collection = `/api/v1/funds/${fundId}/notes`;
  const before = (await query('finance', 'SELECT current_balance::text,finance_version FROM funds WHERE id=$1', [fundId]))[0];
  const ledgerBefore = (await query('finance', 'SELECT count(*)::int count FROM fund_transactions WHERE fund_id=$1', [fundId]))[0];
  const relatedBefore = (await query('finance', `SELECT
    (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1) outbox,
    (SELECT count(*)::int FROM fund_expenses WHERE fund_id=$1) expenses,
    (SELECT count(*)::int FROM fund_refunds WHERE fund_id=$1) refunds,
    (SELECT count(*)::int FROM contribution_requests WHERE fund_id=$1) requests`, [fundId]))[0];
  assert.equal((await mutate(collection, 'POST', { description: 'Taxi', expected_finance_version: before.finance_version }, outsider)).status, 404);
  assert.equal((await mutate(collection, 'POST', { description: 'Taxi', payer_user_id: outsider.id, expected_finance_version: before.finance_version }, holder)).status, 409);
  const key = randomUUID();
  const body = { description: '  Taxi sân bay  ', amount: '0', payer_user_id: holder.id, expected_finance_version: before.finance_version };
  const created = await mutate(collection, 'POST', body, holder, key);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.description, 'Taxi sân bay');
  assert.equal(created.body.data.amount, '0');
  const noteId = created.body.data.id;
  const replay = await mutate(collection, 'POST', body, holder, key);
  assert.equal(replay.body.data.id, noteId);
  assert.equal((await mutate(collection, 'POST', { ...body, description: 'Different' }, holder, key)).status, 409);
  const item = `/api/v1/notes/${noteId}`;
  await query('trip', "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())", [tripId, outsider.id]);
  assert.equal((await mutate(item, 'PATCH', { description: 'Denied', expected_version: 1, expected_finance_version: created.body.data.finance_version }, outsider)).status, 403);
  const noOp = await mutate(item, 'PATCH', { description: 'Taxi sân bay', expected_version: 1, expected_finance_version: created.body.data.finance_version }, holder);
  assert.equal(noOp.body.data.version, 1);
  assert.equal(noOp.body.data.finance_version, created.body.data.finance_version);
  const updated = await mutate(item, 'PATCH', { amount: null, payer_user_id: null, expected_version: 1, expected_finance_version: created.body.data.finance_version }, owner);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.amount, null);
  assert.equal(updated.body.data.payer_user_id, null);
  const page = await request(`${collection}?limit=1`, 'GET', undefined, bearer(holder));
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.status, 200);
  assert.equal(page.body.data.items[0].id, noteId);
  const removed = await mutate(item, 'DELETE', { expected_version: 2, expected_finance_version: updated.body.data.finance_version }, owner);
  assert.equal(removed.status, 200);
  let empty;
  await waitFor(async () => {
    empty = await request(collection, 'GET', undefined, bearer(holder));
    return empty.status === 200;
  });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.data.items.length, 0);
  const after = (await query('finance', 'SELECT current_balance::text FROM funds WHERE id=$1', [fundId]))[0];
  const ledgerAfter = (await query('finance', 'SELECT count(*)::int count FROM fund_transactions WHERE fund_id=$1', [fundId]))[0];
  const relatedAfter = (await query('finance', `SELECT
    (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1) outbox,
    (SELECT count(*)::int FROM fund_expenses WHERE fund_id=$1) expenses,
    (SELECT count(*)::int FROM fund_refunds WHERE fund_id=$1) refunds,
    (SELECT count(*)::int FROM contribution_requests WHERE fund_id=$1) requests`, [fundId]))[0];
  assert.equal(after.current_balance, before.current_balance);
  assert.equal(ledgerAfter.count, ledgerBefore.count);
  assert.deepEqual(relatedAfter, relatedBefore);
  pass('Financial Notes create/replay/no-op/Owner update/soft-delete do not move Fund money');
}
