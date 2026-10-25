import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  FundCommandRepository,
  fundCommandHash,
} = require('../apps/finance-service/dist/repositories/fund-command.repository.js');
const {
  parseContributionManagementInput,
} = require('../apps/finance-service/dist/inputs/contribution-management.input.js');

export async function runContributionManagementTests(h, helpers) {
  const { request, query, transaction, bearer, pass } = h;
  const { owner, holder, member, outsider } = h.actors;
  const { newTrip, write, enableBody, repo, tripClient, pollTerminal, financeDb } = helpers;
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
  const dest = (
    await query('finance', 'SELECT * FROM payment_destinations WHERE fund_id=$1', [fundId])
  )[0];
  assert.equal(
    (
      await write(
        `/api/v1/funds/${fundId}/destinations/${dest.id}/confirm`,
        { expected_version: 1, expected_finance_version: 1 },
        holder,
      )
    ).status,
    200,
  );
  const create = async () => {
    const result = await write(`/api/v1/funds/${fundId}/contribution-requests`, {
      title: 'Shared meals',
      due_at: '2026-10-20T00:00:00Z',
      contributions: [member, holder].map((user) => ({
        member_user_id: user.id,
        amount: '300000',
        destination_id: dest.id,
      })),
      expected_finance_version: (await fund()).finance_version,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.data;
  };
  const get = async (id) =>
    (await query('finance', 'SELECT * FROM contributions WHERE id=$1', [id]))[0];
  const req = async (id) =>
    (await query('finance', 'SELECT * FROM contribution_requests WHERE id=$1', [id]))[0];
  const versions = async (id, isRequest = false) => ({
    expected_version: (await (isRequest ? req(id) : get(id))).version,
    expected_finance_version: (await fund()).finance_version,
  });
  const path = (id, action = 'amount') =>
    action === 'request'
      ? `/api/v1/funds/${fundId}/contribution-requests/${id}`
      : `/api/v1/contributions/${id}${action === 'amount' ? '' : '/' + action}`;
  const send = async (id, action, body, user = owner, key = randomUUID()) => {
    const invoke = () =>
      request(path(id, action), ['amount', 'request'].includes(action) ? 'PATCH' : 'POST', body, {
        ...bearer(user),
        'idempotency-key': key,
      });
    let result = await invoke();
    if (result.status === 202) {
      await pollTerminal(key);
      result = await invoke();
    }
    return result;
  };
  const patch = async (id, action, fields, user = owner, key) =>
    send(id, action, { ...(await versions(id, action === 'request')), ...fields }, user, key);
  const created = await create(),
    id = created.contributions.find((c) => c.member_user_id === member.id).id,
    second = created.contributions.find((c) => c.member_user_id === holder.id).id;
  for (const user of [holder, member, outsider])
    assert.equal(
      (await patch(id, 'amount', { amount: '400000' }, user)).status,
      user === outsider ? 404 : 403,
    );
  assert.equal(
    (await request(path(id), 'PATCH', { ...(await versions(id)), amount: '4' })).status,
    401,
  );
  for (const fields of [
    { amount: null },
    { amount: 1 },
    { amount: '0' },
    { amount: '9223372036854775808' },
    { amount: '4', fund_id: fundId },
    { amount: '4', expected_version: 0 },
  ])
    assert.equal((await patch(id, 'amount', fields)).status, 400);
  for (const fields of [
    { title: null },
    { title: ' ' },
    { due_at: '2026-02-30T00:00:00Z' },
    { note: null },
  ])
    assert.equal((await patch(created.id, 'request', fields)).status, 400);
  for (const action of ['waive', 'cancel'])
    assert.equal((await patch(id, action, { reason: ' ' })).status, 400);
  assert.equal(
    (await send(randomUUID(), 'amount', { ...(await versions(id)), amount: '4' })).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/v1/funds/${randomUUID()}/contribution-requests/${created.id}`,
        'PATCH',
        { ...(await versions(created.id, true)), title: 'Cross' },
        { ...bearer(owner), 'idempotency-key': randomUUID() },
      )
    ).status,
    404,
  );
  pass('API081-084 authenticate Owner, resolve contribution scope and reject malformed input');

  const original = await get(id),
    initialBalance = (await fund()).current_balance;
  const key = randomUUID(),
    body = { ...(await versions(id)), amount: '0009007199254740993' };
  const updated = await send(id, 'amount', body, owner, key);
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.amount, '9007199254740993');
  assert.equal(updated.body.data.version, 2);
  assert.deepEqual((await get(id)).destination_snapshot, original.destination_snapshot);
  assert.equal((await req(created.id)).version, 1);
  const noopKey = randomUUID(),
    before = await fund();
  assert.equal(
    (await patch(id, 'amount', { amount: '9007199254740993' }, owner, noopKey)).status,
    200,
  );
  assert.equal((await fund()).finance_version, before.finance_version);
  for (const table of ['outbox_events', 'finance_audit_logs']) {
    const column = table === 'outbox_events' ? 'operation_id' : "details->>'operation_id'";
    assert.equal(
      (
        await query('finance', `SELECT count(*) AS n FROM ${table} WHERE ${column}=$1`, [noopKey])
      )[0].n,
      '0',
    );
  }
  assert.equal((await repo.find(noopKey)).status, 'COMMITTED');
  const metaKey = randomUUID();
  const childrenBefore = await query(
    'finance',
    'SELECT * FROM contributions WHERE request_id=$1 ORDER BY id',
    [created.id],
  );
  assert.equal(
    (
      await patch(
        created.id,
        'request',
        { title: 'Shared transport', note: '', due_at: '2026-10-21T00:00:00Z' },
        owner,
        metaKey,
      )
    ).status,
    200,
  );
  assert.deepEqual(
    await query('finance', 'SELECT * FROM contributions WHERE request_id=$1 ORDER BY id', [
      created.id,
    ]),
    childrenBefore,
  );
  const events = await query('finance', 'SELECT * FROM outbox_events WHERE operation_id=$1', [
    metaKey,
  ]);
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((e) => e.event_id)).size, 2);
  assert.equal(new Set(events.map((e) => e.aggregate_version)).size, 1);
  const { validateEventForPublish } = require('../packages/contracts/dist/events.js');
  for (const e of events) {
    const envelope = Object.fromEntries(
      [
        'event_id',
        'event_type',
        'schema_version',
        'producer',
        'aggregate_type',
        'aggregate_id',
        'aggregate_version',
        'correlation_id',
        'causation_id',
        'operation_id',
        'trip_id',
        'actor_user_id',
        'system_actor',
        'payload',
      ].map((key) => [key, e[key]]),
    );
    validateEventForPublish({ ...envelope, occurred_at: e.occurred_at.toISOString() });
    assert.equal(e.event_type, 'ContributionUpdated');
    assert.equal(e.payload.finance_version, (await fund()).finance_version);
    assert(!JSON.stringify(e.payload).includes('destination'));
  }
  assert.deepEqual((await send(id, 'amount', body, owner, key)).body.data, updated.body.data);
  assert.equal((await send(id, 'amount', { ...body, amount: '4' }, owner, key)).status, 409);
  pass(
    'API081-082 preserve snapshots, emit per-child events, keep no-op versions and replay saved results',
  );

  // Explicit SQL fixtures: manual/payment writers are outside this increment.
  await query(
    'finance',
    "UPDATE contributions SET status='TRANSFER_REPORTED',member_reported_at=now(),transfer_evidence_object_key='private-proof' WHERE id=$1",
    [id],
  );
  assert.equal(
    (await patch(created.id, 'request', { due_at: '2026-10-22T00:00:00Z' })).status,
    409,
  );
  assert.equal(
    (await patch(created.id, 'request', { title: 'Metadata after report' })).status,
    200,
  );
  assert.equal(
    (await patch(created.id, 'request', { due_at: '2026-10-21T07:00:00+07:00' })).status,
    200,
  );
  for (const action of ['amount', 'waive', 'cancel'])
    assert.equal(
      (await patch(id, action, action === 'amount' ? { amount: '4' } : { reason: 'Reason' }))
        .status,
      409,
    );
  await query(
    'finance',
    "UPDATE contributions SET status='PENDING',rejected_reason='Not received' WHERE id=$1",
    [id],
  );
  const history = await get(id);
  for (const [status, reconcile] of [
    ['CREATED', false],
    ['PENDING', false],
    ['SUCCEEDED', false],
    ['FAILED', true],
    ['EXPIRED', true],
  ]) {
    const attempt = (
      await query(
        'finance',
        `INSERT INTO payment_attempts(contribution_id,provider,environment,amount,client_request_id,status,merchant_id,provider_order_id,destination_snapshot,needs_reconciliation) VALUES($1,'VIETQR','TEST',300000,$2,$3,'test',$2,'{}',$4) RETURNING id`,
        [id, randomUUID(), status, reconcile],
      )
    )[0];
    for (const action of ['amount', 'waive', 'cancel'])
      assert.equal(
        (await patch(id, action, action === 'amount' ? { amount: '4' } : { reason: 'Reason' }))
          .status,
        409,
      );
    assert.equal(
      (await patch(created.id, 'request', { due_at: '2026-10-22T00:00:00Z' })).status,
      409,
    );
    await query('finance', 'DELETE FROM payment_attempts WHERE id=$1', [attempt.id]);
  }
  await query(
    'finance',
    `INSERT INTO payment_attempts(contribution_id,provider,environment,amount,client_request_id,status,merchant_id,provider_order_id,destination_snapshot) VALUES($1,'VIETQR','TEST',300000,$2,'FAILED','test',$2,'{}')`,
    [id, randomUUID()],
  );
  const waived = await patch(id, 'waive', { reason: 'Covered by group' });
  assert.equal(waived.status, 200);
  assert.equal(waived.body.data.status, 'WAIVED');
  assert.equal(waived.body.data.waived_reason, 'Covered by group');
  const afterWaive = await get(id);
  for (const field of [
    'member_reported_at',
    'transfer_evidence_object_key',
    'rejected_reason',
    'destination_snapshot',
  ])
    assert.deepEqual(afterWaive[field], history[field]);
  assert(afterWaive.waived_at);
  const cancelled = await patch(second, 'cancel', { reason: 'Duplicate obligation' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.status, 'CANCELLED');
  assert((await get(second)).cancelled_at);
  for (const target of [id, second])
    assert.equal((await patch(target, 'amount', { amount: '4' })).status, 409);
  const noWaitKey = randomUUID();
  assert.equal(
    (
      await patch(
        created.id,
        'request',
        { note: 'Closed obligations, request remains open' },
        owner,
        noWaitKey,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM outbox_events WHERE operation_id=$1', [
        noWaitKey,
      ])
    )[0].n,
    '0',
  );
  assert.equal((await req(created.id)).status, 'OPEN');
  assert.equal((await fund()).current_balance, initialBalance);
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM fund_transactions WHERE fund_id=$1', [
        fundId,
      ])
    )[0].n,
    '0',
  );
  pass(
    'API081-084 block reported/unresolved/succeeded payments; waive/cancel preserve history without ledger or balance writes',
  );

  const fresh = await create(),
    target = fresh.contributions[0].id;
  await query(
    'finance',
    "UPDATE contribution_requests SET due_at='2026-10-20T00:00:00.123456Z' WHERE id=$1",
    [fresh.id],
  );
  const deadline = async () =>
    (
      await query(
        'finance',
        "SELECT to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS value FROM contribution_requests WHERE id=$1",
        [fresh.id],
      )
    )[0].value;
  const originalDeadline = await deadline();
  assert.equal(
    (await patch(fresh.id, 'request', { title: 'Preserve omitted deadline' })).status,
    200,
  );
  assert.equal(await deadline(), originalDeadline);
  assert.equal(
    (
      await patch(fresh.id, 'request', {
        note: 'Same normalized instant',
        due_at: '2026-10-20T00:00:00.123Z',
      })
    ).status,
    200,
  );
  assert.equal(await deadline(), originalDeadline);

  const ledgerTarget = fresh.contributions[1].id;
  await query(
    'finance',
    `INSERT INTO fund_transactions(fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,business_key) VALUES($1,1,'IN','CONTRIBUTION',300000,300000,$2,$3) RETURNING id`,
    [fundId, ledgerTarget, randomUUID()],
  );
  assert.equal(
    (await patch(ledgerTarget, 'cancel', { reason: 'Cannot cancel posted receipt' })).status,
    409,
  );
  const targetUser = (await get(target)).member_user_id;
  await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    targetUser,
  ]);
  assert.equal((await patch(target, 'amount', { amount: '4' })).status, 409);
  await query('trip', 'UPDATE trip_members SET left_at=NULL WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    targetUser,
  ]);
  for (const status of ['CLOSING', 'CLOSED']) {
    await query('finance', 'UPDATE funds SET status=$2 WHERE id=$1', [fundId, status]);
    assert.equal((await patch(target, 'amount', { amount: '4' })).status, 409);
  }
  await query('finance', "UPDATE funds SET status='OPEN' WHERE id=$1", [fundId]);
  await query('finance', "UPDATE contribution_requests SET status='CLOSED' WHERE id=$1", [
    fresh.id,
  ]);
  assert.equal((await patch(target, 'amount', { amount: '4' })).status, 409);
  await query('finance', "UPDATE contribution_requests SET status='OPEN' WHERE id=$1", [fresh.id]);
  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [tripId]);
  assert.equal((await patch(target, 'amount', { amount: '4' })).status, 409);
  await query('trip', 'UPDATE trips SET archived_at=NULL WHERE id=$1', [tripId]);
  await query('trip', 'UPDATE trips SET closure_lock_id=$2 WHERE id=$1', [tripId, randomUUID()]);
  assert.equal((await patch(target, 'amount', { amount: '4' })).status, 409);
  await query('trip', 'UPDATE trips SET closure_lock_id=NULL WHERE id=$1', [tripId]);
  const savedVersion = (await fund()).finance_version;
  await query('finance', 'UPDATE funds SET finance_version=2147483647 WHERE id=$1', [fundId]);
  assert.equal((await patch(target, 'amount', { amount: '300000' })).status, 200);
  assert.equal((await patch(target, 'amount', { amount: '4' })).status, 409);
  await query('finance', 'UPDATE funds SET finance_version=$2 WHERE id=$1', [fundId, savedVersion]);
  pass(
    'API081-084 reject posted ledger, inactive targets, closed/archived resources and version overflow',
  );

  const concurrentBody = { ...(await versions(target)), amount: '400000' };
  const concurrent = await Promise.all([
    send(target, 'amount', concurrentBody),
    send(target, 'amount', concurrentBody),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  const sameKey = randomUUID(),
    sameBody = { ...(await versions(target)), amount: '500000' };
  const same = await Promise.all([
    send(target, 'amount', sameBody, owner, sameKey),
    send(target, 'amount', sameBody, owner, sameKey),
  ]);
  assert(same.every((r) => r.status === 200));
  assert.deepEqual(same[0].body.data, same[1].body.data);
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM outbox_events WHERE operation_id=$1', [
        sameKey,
      ])
    )[0].n,
    '1',
  );
  await query(
    'trip',
    "UPDATE trip_members SET role='MEMBER',left_at=now() WHERE trip_id=$1 AND user_id=$2",
    [tripId, owner.id],
  );
  assert.equal((await send(target, 'amount', sameBody, owner, sameKey)).status, 404);
  await query(
    'trip',
    "UPDATE trip_members SET role='OWNER',left_at=NULL WHERE trip_id=$1 AND user_id=$2",
    [tripId, owner.id],
  );
  pass('API082 concurrent writes serialize versions and replay rechecks current membership');

  const prepare = async (scope, requestId, contributionId, fields) => {
    const raw = {
      ...(await versions(
        scope === 'UPDATE_CONTRIBUTION_REQUEST' ? requestId : contributionId,
        scope === 'UPDATE_CONTRIBUTION_REQUEST',
      )),
      ...fields,
    };
    const intent = {
      scope,
      actor: owner.id,
      tripId,
      fundId,
      requestId,
      contributionId,
      body: parseContributionManagementInput(scope, raw),
    };
    const input = { ...intent, operationId: randomUUID(), hash: fundCommandHash(intent) };
    const guard = await tripClient.call(
      'BeginFinanceOperation',
      {
        operation_id: input.operationId,
        trip_id: tripId,
        actor: { actor_user_id: owner.id },
        command: scope,
        request_hash: input.hash,
      },
      randomUUID(),
      Date.now() + 5000,
    );
    return {
      input,
      guard,
      raw,
      cancel: {
        operation_id: input.operationId,
        command_scope: scope,
        request_hash: input.hash,
        authorization_context: guard.context,
      },
    };
  };
  const recover = async (p) => {
    await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
      p.input.operationId,
    ]);
    return pollTerminal(p.input.operationId);
  };
  const snapshot = async () => {
    const result = { fund: await fund() };
    for (const table of ['contribution_requests', 'contributions', 'finance_audit_logs'])
      result[table] = await query(
        'finance',
        `SELECT * FROM ${table} WHERE fund_id=$1 ORDER BY id`,
        [fundId],
      );
    result.events = await query(
      'finance',
      'SELECT * FROM outbox_events WHERE aggregate_id=$1 ORDER BY event_id',
      [fundId],
    );
    return result;
  };
  for (const failAt of [
    'UPDATE funds',
    'INSERT INTO finance_audit_logs',
    'INSERT INTO outbox_events',
    'INSERT INTO command_receipts',
  ]) {
    const p = await prepare('UPDATE_CONTRIBUTION_AMOUNT', fresh.id, target, { amount: '600000' }),
      before = await snapshot();
    const broken = new FundCommandRepository({
      ...financeDb,
      withTransaction: (work) =>
        transaction('finance', (client) =>
          work({
            query: (sql, args) => {
              if (sql.includes(failAt)) throw new Error('Injected management failure');
              return client.query(sql, args);
            },
          }),
        ),
    });
    await assert.rejects(() => broken.execute(p.input, p.guard, randomUUID()), /Injected/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await repo.find(p.input.operationId), undefined);
    assert.equal(await recover(p), 'FAILED');
  }
  pass(
    'API082 injected mutation/audit/outbox/receipt failures roll back atomically and recover cancellation',
  );
  for (const [scope, action, fields] of [
    ['UPDATE_CONTRIBUTION_REQUEST', 'request', { title: 'Recovered metadata' }],
    ['UPDATE_CONTRIBUTION_AMOUNT', 'amount', { amount: '700000' }],
    ['WAIVE_CONTRIBUTION', 'waive', { reason: 'Recovered waiver' }],
    ['CANCEL_CONTRIBUTION', 'cancel', { reason: 'Recovered cancellation' }],
  ]) {
    const allocation = await create(),
      child = allocation.contributions[0].id;
    const cancelled = await prepare(
      scope,
      allocation.id,
      scope === 'UPDATE_CONTRIBUTION_REQUEST' ? undefined : child,
      fields,
    );
    assert.equal((await repo.cancel(cancelled.cancel)).status, 'CANCELLED');
    assert.equal(
      (await repo.execute(cancelled.input, cancelled.guard, randomUUID())).status,
      'CANCELLED',
    );
    assert.equal(await recover(cancelled), 'FAILED');
    const p = await prepare(
      scope,
      allocation.id,
      scope === 'UPDATE_CONTRIBUTION_REQUEST' ? undefined : child,
      fields,
    );
    const receipt = await repo.execute(p.input, p.guard, randomUUID());
    assert.equal(receipt.status, 'COMMITTED');
    assert.equal((await repo.cancel(p.cancel)).status, 'COMMITTED');
    if (scope === 'UPDATE_CONTRIBUTION_REQUEST') await h.restartTrip();
    assert.equal(await recover(p), 'SUCCEEDED');
    const result = await send(
      action === 'request' ? allocation.id : child,
      action,
      p.raw,
      owner,
      p.input.operationId,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const raceAllocation = await create(),
      raceChild = raceAllocation.contributions[0].id;
    const race = await prepare(
      scope,
      raceAllocation.id,
      scope === 'UPDATE_CONTRIBUTION_REQUEST' ? undefined : raceChild,
      fields,
    );
    const raced = await Promise.all([
      repo.execute(race.input, race.guard, randomUUID()),
      repo.cancel(race.cancel),
    ]);
    assert.equal(raced[0].status, raced[1].status);
    await recover(race);
  }
  pass(
    'All four management commands recover lost completion/restart and fence execute-cancel races',
  );
}
