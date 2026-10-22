import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runContributionReversalTests(h, helpers) {
  const { request, query, bearer, pass } = h;
  const { owner, holder, member, outsider } = h.actors;
  const { newTrip, write, enableBody, pollTerminal } = helpers;
  const tripId = await newTrip();
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
    [tripId, member.id],
  );
  const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody());
  assert.equal(enabled.status, 201);
  const fundId = enabled.body.data.id;
  const fund = async () => (await query('finance', 'SELECT * FROM funds WHERE id=$1', [fundId]))[0];
  const destination = (
    await query('finance', 'SELECT * FROM payment_destinations WHERE fund_id=$1', [fundId])
  )[0];
  assert.equal(
    (
      await write(
        `/api/v1/funds/${fundId}/destinations/${destination.id}/confirm`,
        { expected_version: 1, expected_finance_version: 1 },
        holder,
      )
    ).status,
    200,
  );
  const getContribution = async (id) =>
    (await query('finance', 'SELECT * FROM contributions WHERE id=$1', [id]))[0];
  const create = async () => {
    const response = await write(`/api/v1/funds/${fundId}/contribution-requests`, {
      title: 'Reversal test',
      contributions: [
        { member_user_id: member.id, amount: '300000', destination_id: destination.id },
      ],
      expected_finance_version: (await fund()).finance_version,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.contributions[0].id;
  };
  const invoke = async (id, action, body, actor, key = randomUUID()) => {
    const call = () =>
      request(`/api/v1/contributions/${id}/${action}`, 'POST', body, {
        ...bearer(actor),
        'idempotency-key': key,
      });
    let response = await call();
    if (response.status === 202) {
      await pollTerminal(key);
      response = await call();
    }
    return response;
  };
  const versions = async (id) => ({
    expected_version: (await getContribution(id)).version,
    expected_finance_version: (await fund()).finance_version,
  });
  const confirm = async (id) => {
    assert.equal((await invoke(id, 'report-transfer', await versions(id), member)).status, 200);
    assert.equal((await invoke(id, 'confirm-received', await versions(id), holder)).status, 200);
  };

  const id = await create();
  await confirm(id);
  const body = { ...(await versions(id)), reason: 'Recorded twice' };
  assert.equal((await invoke(id, 'reverse', body, owner)).status, 403);
  assert.equal((await invoke(id, 'reverse', body, member)).status, 403);
  assert.equal((await invoke(id, 'reverse', body, outsider)).status, 404);
  for (const invalid of [
    { ...body, reason: ' ' },
    { ...body, reason: 'x'.repeat(1025) },
    { ...body, amount: '1' },
  ])
    assert.equal((await invoke(id, 'reverse', invalid, holder)).status, 400);

  const refundId = randomUUID();
  await query(
    'finance',
    `INSERT INTO fund_refunds(id,fund_id,member_user_id,amount,status,reason,requested_by_user_id)
     VALUES($1,$2,$3,1,'PENDING','reserved',$4)`,
    [refundId, fundId, member.id, owner.id],
  );
  assert.equal((await invoke(id, 'reverse', body, holder)).status, 409);
  assert.equal((await getContribution(id)).status, 'CONFIRMED');
  assert.equal((await fund()).current_balance, '300000');
  await query('finance', "UPDATE fund_refunds SET status='CANCELLED' WHERE id=$1", [refundId]);

  const key = randomUUID();
  const reversed = await invoke(id, 'reverse', body, holder, key);
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body));
  assert.equal(reversed.body.data.status, 'REVERSED');
  assert.equal((await fund()).current_balance, '0');
  const entries = await query(
    'finance',
    'SELECT * FROM fund_transactions WHERE fund_id=$1 ORDER BY sequence',
    [fundId],
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].direction.trim(), 'IN');
  assert.equal(entries[1].direction.trim(), 'OUT');
  assert.equal(entries[1].transaction_type, 'REVERSAL');
  assert.equal(entries[1].amount, entries[0].amount);
  assert.equal(entries[1].reversal_of_id, entries[0].id);
  assert.equal(entries[1].reason, 'Recorded twice');
  assert.equal(entries[1].actor_user_id, holder.id);
  assert.deepEqual((await invoke(id, 'reverse', body, holder, key)).body.data, reversed.body.data);
  assert.equal((await invoke(id, 'reverse', await versions(id), holder)).status, 400);
  assert.equal(
    (
      await query(
        'finance',
        'SELECT count(*)::int AS count FROM fund_transactions WHERE reversal_of_id=$1',
        [entries[0].id],
      )
    )[0].count,
    1,
  );
  const audit = (
    await query(
      'finance',
      "SELECT details FROM finance_audit_logs WHERE entity_id=$1 AND action='REVERSE_CONTRIBUTION'",
      [id],
    )
  )[0];
  assert.equal(audit.details.reason, 'Recorded twice');
  assert.equal(audit.details.original_ledger_id, entries[0].id);
  assert.equal(audit.details.reversal_ledger_id, entries[1].id);
  const event = (
    await query(
      'finance',
      "SELECT payload FROM outbox_events WHERE operation_id=$1 AND event_type='ContributionUpdated'",
      [key],
    )
  )[0];
  assert.equal(event.payload.status, 'REVERSED');
  assert(!JSON.stringify(event.payload).includes('Recorded twice'));
  pass('API085 reverses one confirmed contribution with an exact linked OUT ledger entry');

  const concurrent = await create();
  await confirm(concurrent);
  const concurrentBody = { ...(await versions(concurrent)), reason: 'Duplicate confirmation' };
  const results = await Promise.all([
    invoke(concurrent, 'reverse', concurrentBody, holder),
    invoke(concurrent, 'reverse', concurrentBody, holder),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(
    (
      await query(
        'finance',
        `SELECT count(*)::int AS count FROM fund_transactions r
         JOIN fund_transactions o ON o.id=r.reversal_of_id WHERE o.contribution_id=$1`,
        [concurrent],
      )
    )[0].count,
    1,
  );
  pass('API085 serializes competing idempotency keys and preserves one reversal per original');

  return [];
}
