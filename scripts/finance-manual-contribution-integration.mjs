import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/finance-service/package.json', import.meta.url));
const {
  FundCommandRepository,
  fundCommandHash,
} = require('./dist/repositories/fund-command.repository.js');
const { parseManualContributionInput } = require('./dist/inputs/manual-contribution.input.js');
const sharp = require('sharp');

export async function runManualContributionTests(h, helpers) {
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
  const get = async (id) =>
    (await query('finance', 'SELECT * FROM contributions WHERE id=$1', [id]))[0];
  const create = async (user = member, amount = '300000') => {
    const r = await write(`/api/v1/funds/${fundId}/contribution-requests`, {
      title: 'Manual shared activities',
      contributions: [{ member_user_id: user.id, amount, destination_id: dest.id }],
      expected_finance_version: (await fund()).finance_version,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.contributions[0].id;
  };
  const versions = async (id) => ({
    expected_version: (await get(id)).version,
    expected_finance_version: (await fund()).finance_version,
  });
  const path = (id, action) => `/api/v1/contributions/${id}/${action}`;
  const send = async (id, action, body, user = member, key = randomUUID()) => {
    const invoke = () =>
      request(path(id, action), 'POST', body, { ...bearer(user), 'idempotency-key': key });
    let r = await invoke();
    if (r.status === 202) {
      await pollTerminal(key);
      r = await invoke();
    }
    return r;
  };
  const act = async (id, action, user = member, fields = {}, key) =>
    send(id, action, { ...(await versions(id)), ...fields }, user, key);
  const entries = () =>
    query('finance', 'SELECT * FROM fund_transactions WHERE fund_id=$1 ORDER BY sequence', [
      fundId,
    ]);
  const first = await create();
  assert.equal(
    (await request(path(first, 'report-transfer'), 'POST', await versions(first))).status,
    401,
  );
  for (const user of [owner, holder, outsider])
    assert.equal((await act(first, 'report-transfer', user)).status, user === outsider ? 404 : 403);
  for (const action of ['confirm-received', 'reject-transfer'])
    assert.equal(
      (
        await act(first, action, owner, {
          ...(action === 'reject-transfer' ? { reason: 'not seen' } : {}),
        })
      ).status,
      403,
    );
  for (const fields of [
    { amount: '1' },
    { expected_version: 0 },
    { evidence_object_key: null },
    { evidence_object_key: '' },
  ])
    assert.equal((await act(first, 'report-transfer', member, fields)).status, 400);
  assert.equal((await act(first, 'confirm-received', holder)).status, 409);
  const reportBody = await versions(first),
    reportKey = randomUUID();
  const reported = await send(first, 'report-transfer', reportBody, member, reportKey);
  assert.equal(reported.status, 200, JSON.stringify(reported.body));
  assert.equal((await fund()).current_balance, '0');
  assert.equal((await entries()).length, 0);
  assert.equal((await act(first, 'reject-transfer', holder, { reason: ' ' })).status, 400);
  assert.equal(
    (await act(first, 'reject-transfer', holder, { reason: 'Not yet received in bank' })).status,
    200,
  );
  assert.equal((await get(first)).status, 'PENDING');
  assert((await get(first)).member_reported_at);
  assert.equal((await get(first)).rejected_reason, 'Not yet received in bank');
  assert.deepEqual(
    (await send(first, 'report-transfer', reportBody, member, reportKey)).body.data,
    reported.body.data,
  );
  assert.equal(
    (
      await send(
        first,
        'report-transfer',
        { ...reportBody, expected_version: 99 },
        member,
        reportKey,
      )
    ).status,
    409,
  );
  assert.equal((await act(first, 'report-transfer')).status, 200);
  const confirmBody = await versions(first),
    confirmKey = randomUUID();
  const confirmed = await send(first, 'confirm-received', confirmBody, holder, confirmKey);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal((await fund()).current_balance, '300000');
  assert.equal((await entries()).length, 1);
  assert.equal((await entries())[0].amount, '300000');
  assert.equal((await entries())[0].actor_user_id, holder.id);
  assert.deepEqual(
    (await send(first, 'confirm-received', confirmBody, holder, confirmKey)).body.data,
    confirmed.body.data,
  );
  assert.equal((await act(first, 'confirm-received', holder)).status, 409);
  const page = await request(
    `/api/v1/funds/${fundId}/transactions`,
    'GET',
    undefined,
    bearer(member),
  );
  assert.equal(page.status, 200);
  assert.equal(page.body.data.items[0].contribution_id, first);
  assert.equal(page.body.data.items[0].balance_after, '300000');
  assert.equal(
    (
      await query('finance', 'SELECT version FROM contribution_requests WHERE id=$1', [
        (await get(first)).request_id,
      ])
    )[0].version,
    1,
  );
  await query('finance', 'UPDATE funds SET holder_user_id=$2 WHERE id=$1', [fundId, owner.id]);
  assert.equal(
    (await send(first, 'confirm-received', confirmBody, holder, confirmKey)).status,
    403,
  );
  await query('finance', 'UPDATE funds SET holder_user_id=$2 WHERE id=$1', [fundId, holder.id]);
  await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    member.id,
  ]);
  assert.equal((await send(first, 'report-transfer', reportBody, member, reportKey)).status, 404);
  await query('trip', 'UPDATE trip_members SET left_at=NULL WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    member.id,
  ]);
  pass(
    'API087-089 enforce Self/Holder, preserve rejection history, replay snapshots and record one ledger IN',
  );

  const own = await create(holder);
  assert.equal((await act(own, 'report-transfer', holder)).status, 200);
  assert.equal((await act(own, 'confirm-received', holder)).body.data.self_contribution, true);
  const concurrent = await create();
  assert.equal((await act(concurrent, 'report-transfer')).status, 200);
  const cb = await versions(concurrent);
  assert.deepEqual(
    (
      await Promise.all([
        send(concurrent, 'confirm-received', cb, holder),
        send(concurrent, 'confirm-received', cb, holder),
      ])
    )
      .map((r) => r.status)
      .sort(),
    [200, 409],
  );
  const same = await create();
  assert.equal((await act(same, 'report-transfer')).status, 200);
  const sb = await versions(same),
    sk = randomUUID();
  const sameResults = await Promise.all([
    send(same, 'confirm-received', sb, holder, sk),
    send(same, 'confirm-received', sb, holder, sk),
  ]);
  assert(sameResults.every((r) => r.status === 200));
  assert.deepEqual(sameResults[0].body.data, sameResults[1].body.data);
  assert.equal((await entries()).filter((r) => r.contribution_id === same).length, 1);
  const departed = await create();
  assert.equal((await act(departed, 'report-transfer')).status, 200);
  await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    member.id,
  ]);
  assert.equal((await act(departed, 'confirm-received', holder)).status, 200);
  await query('trip', 'UPDATE trip_members SET left_at=NULL WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    member.id,
  ]);
  pass(
    'Manual confirmations serialize concurrent keys, support Holder self-payment and review departed-member reports',
  );

  const target = await create();
  for (const status of ['CLOSING', 'CLOSED']) {
    await query('finance', 'UPDATE funds SET status=$2 WHERE id=$1', [fundId, status]);
    assert.equal((await act(target, 'report-transfer')).status, 409);
  }
  await query('finance', "UPDATE funds SET status='OPEN' WHERE id=$1", [fundId]);
  await query('finance', "UPDATE contribution_requests SET status='CLOSED' WHERE id=$1", [
    (await get(target)).request_id,
  ]);
  assert.equal((await act(target, 'report-transfer')).status, 409);
  await query('finance', "UPDATE contribution_requests SET status='OPEN' WHERE id=$1", [
    (await get(target)).request_id,
  ]);
  for (const field of ['archived_at', 'closure_lock_id']) {
    await query('trip', `UPDATE trips SET ${field}=$2 WHERE id=$1`, [
      tripId,
      field === 'archived_at' ? new Date() : randomUUID(),
    ]);
    assert.equal((await act(target, 'report-transfer')).status, 409);
    await query('trip', `UPDATE trips SET ${field}=NULL WHERE id=$1`, [tripId]);
  }
  for (const state of ['WAIVED', 'CANCELLED', 'REVERSED']) {
    await query('finance', 'UPDATE contributions SET status=$2 WHERE id=$1', [target, state]);
    assert.equal((await act(target, 'report-transfer')).status, 409);
  }
  await query('finance', "UPDATE contributions SET status='PENDING' WHERE id=$1", [target]);
  for (const table of ['funds', 'contributions']) {
    const column = table === 'funds' ? 'finance_version' : 'version',
      id = table === 'funds' ? fundId : target;
    const old = (await query('finance', `SELECT ${column} AS v FROM ${table} WHERE id=$1`, [id]))[0]
      .v;
    await query('finance', `UPDATE ${table} SET ${column}=2147483647 WHERE id=$1`, [id]);
    assert.equal((await act(target, 'report-transfer')).status, 409);
    await query('finance', `UPDATE ${table} SET ${column}=$2 WHERE id=$1`, [id, old]);
  }
  assert.equal(
    (await act(target, 'report-transfer', member, { expected_version: 99 })).status,
    409,
  );
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
        [target, randomUUID(), status, reconcile],
      )
    )[0];
    assert.equal((await act(target, 'report-transfer')).status, 409);
    await query('finance', 'DELETE FROM payment_attempts WHERE id=$1', [attempt.id]);
  }
  await query(
    'finance',
    `INSERT INTO payment_attempts(contribution_id,provider,environment,amount,client_request_id,status,merchant_id,provider_order_id,destination_snapshot) VALUES($1,'VIETQR','TEST',300000,$2,'FAILED','test',$2,'{}')`,
    [target, randomUUID()],
  );
  assert.equal((await act(target, 'report-transfer')).status, 200);
  const huge = await create(member, '9223372036854775807');
  assert.equal((await act(huge, 'report-transfer')).status, 200);
  assert.equal((await act(huge, 'confirm-received', holder)).status, 409);
  assert.equal((await get(huge)).status, 'TRANSFER_REPORTED');
  const exact = await create(member, '9007199254740993'),
    balance = BigInt((await fund()).current_balance);
  assert.equal((await act(exact, 'report-transfer')).status, 200);
  assert.equal((await act(exact, 'confirm-received', holder)).status, 200);
  assert.equal((await fund()).current_balance, (balance + 9007199254740993n).toString());
  pass(
    'Manual writers reject lifecycle/state/version/amount overflow and preserve exact int64 money',
  );

  const keys = [];
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const upload = async (user = member) => {
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'test.png');
    const r = await fetch(`${h.gatewayUrl}/api/v1/funds/${fundId}/receipts`, {
      method: 'POST',
      headers: bearer(user),
      body: form,
    });
    assert.equal(r.status, 201);
    const key = (await r.json()).data.object_key;
    keys.push(key);
    return key;
  };
  const download = async (key, user = member) => {
    const r = await fetch(
      `${h.gatewayUrl}/api/v1/funds/${fundId}/receipts/download?object_key=${encodeURIComponent(key)}`,
      { headers: bearer(user) },
    );
    await r.arrayBuffer();
    return r.status;
  };
  const evidenceTarget = await create(),
    key = await upload();
  assert.equal(await download(key), 404);
  assert.equal(
    (
      await act(evidenceTarget, 'report-transfer', member, {
        evidence_object_key: await upload(holder),
      })
    ).status,
    409,
  );
  assert.equal(
    (await act(evidenceTarget, 'report-transfer', member, { evidence_object_key: key })).status,
    200,
  );
  assert.equal(await download(key), 200);
  assert.equal(await download(key, holder), 200);
  assert.equal(await download(key, owner), 404);
  assert.equal(
    (await act(evidenceTarget, 'reject-transfer', holder, { reason: 'check again' })).status,
    200,
  );
  assert.equal(
    (await act(evidenceTarget, 'report-transfer', member, { evidence_object_key: key })).status,
    200,
  );
  assert.equal(
    (await act(evidenceTarget, 'reject-transfer', holder, { reason: 'retry without key' })).status,
    200,
  );
  assert.equal((await act(evidenceTarget, 'report-transfer')).status, 200);
  assert.equal((await get(evidenceTarget)).transfer_evidence_object_key, key);
  assert.equal(
    (await act(evidenceTarget, 'reject-transfer', holder, { reason: 'replace' })).status,
    200,
  );
  const replacement = await upload();
  assert.equal(
    (await act(evidenceTarget, 'report-transfer', member, { evidence_object_key: replacement }))
      .status,
    200,
  );
  assert.equal(await download(key), 200);
  assert.equal(await download(replacement), 200);
  const other = await create();
  assert.equal(
    (await act(other, 'report-transfer', member, { evidence_object_key: key })).status,
    409,
  );
  const deleting = await upload();
  await query('finance', "UPDATE finance_files SET state='DELETING' WHERE object_key=$1", [
    deleting,
  ]);
  assert.equal(
    (await act(other, 'report-transfer', member, { evidence_object_key: deleting })).status,
    409,
  );
  assert(
    !JSON.stringify(
      (await request(`/api/v1/funds/${fundId}/contributions`, 'GET', undefined, bearer(member)))
        .body,
    ).includes(replacement),
  );
  pass(
    'Manual report atomically binds verified evidence, retains old files and rejects other owners/bindings/cleanup claims',
  );

  const actions = {
    REPORT_TRANSFER: 'report-transfer',
    CONFIRM_RECEIVED: 'confirm-received',
    REJECT_TRANSFER: 'reject-transfer',
  };
  const prepare = async (scope, id) => {
    const actor = scope === 'REPORT_TRANSFER' ? member : holder,
      raw = {
        ...(await versions(id)),
        ...(scope === 'REJECT_TRANSFER' ? { reason: 'recovery rejection' } : {}),
      };
    const intent = {
      scope,
      actor: actor.id,
      tripId,
      fundId,
      requestId: (await get(id)).request_id,
      contributionId: id,
      body: parseManualContributionInput(scope, raw),
    };
    const input = { ...intent, operationId: randomUUID(), hash: fundCommandHash(intent) };
    const guard = await tripClient.call(
      'BeginFinanceOperation',
      {
        operation_id: input.operationId,
        trip_id: tripId,
        actor: { actor_user_id: actor.id },
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
      actor,
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
    for (const table of [
      'contributions',
      'fund_transactions',
      'finance_audit_logs',
      'finance_files',
    ])
      result[table] = await query(
        'finance',
        `SELECT * FROM ${table} WHERE fund_id=$1 ORDER BY ${table === 'finance_files' ? 'object_key' : 'id'}`,
        [fundId],
      );
    result.events = await query(
      'finance',
      'SELECT * FROM outbox_events WHERE aggregate_id=$1 ORDER BY event_id',
      [fundId],
    );
    return result;
  };
  const faultTarget = await create();
  assert.equal((await act(faultTarget, 'report-transfer')).status, 200);
  for (const failAt of [
    'INSERT INTO fund_transactions',
    'UPDATE contributions',
    'UPDATE funds',
    'INSERT INTO finance_audit_logs',
    'INSERT INTO outbox_events',
    'INSERT INTO command_receipts',
  ]) {
    const p = await prepare('CONFIRM_RECEIVED', faultTarget),
      before = await snapshot();
    const broken = new FundCommandRepository({
      ...financeDb,
      withTransaction: (work) =>
        transaction('finance', (client) =>
          work({
            query: (sql, args) => {
              if (sql.includes(failAt)) throw new Error('Injected manual failure');
              return client.query(sql, args);
            },
          }),
        ),
    });
    await assert.rejects(() => broken.execute(p.input, p.guard, randomUUID()), /Injected manual/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await repo.find(p.input.operationId), undefined);
    assert.equal(await recover(p), 'FAILED');
  }
  pass(
    'Manual confirmation rolls back ledger/balance/contribution/audit/outbox/receipt together on injected SQL failures',
  );
  for (const scope of Object.keys(actions)) {
    const id = await create();
    if (scope !== 'REPORT_TRANSFER') assert.equal((await act(id, 'report-transfer')).status, 200);
    const cancelled = await prepare(scope, id);
    assert.equal((await repo.cancel(cancelled.cancel)).status, 'CANCELLED');
    assert.equal(
      (await repo.execute(cancelled.input, cancelled.guard, randomUUID())).status,
      'CANCELLED',
    );
    assert.equal(await recover(cancelled), 'FAILED');
    const p = await prepare(scope, id),
      receipt = await repo.execute(p.input, p.guard, randomUUID());
    assert.equal(receipt.status, 'COMMITTED');
    assert.equal((await repo.cancel(p.cancel)).status, 'COMMITTED');
    if (scope === 'CONFIRM_RECEIVED') await h.restartTrip();
    assert.equal(await recover(p), 'SUCCEEDED');
    assert.equal((await send(id, actions[scope], p.raw, p.actor, p.input.operationId)).status, 200);
    const raceId = await create();
    if (scope !== 'REPORT_TRANSFER')
      assert.equal((await act(raceId, 'report-transfer')).status, 200);
    const race = await prepare(scope, raceId),
      results = await Promise.all([
        repo.execute(race.input, race.guard, randomUUID()),
        repo.cancel(race.cancel),
      ]);
    assert.equal(results[0].status, results[1].status);
    await recover(race);
  }
  const ledger = await entries();
  assert.equal(
    BigInt((await fund()).current_balance),
    ledger.reduce((sum, r) => sum + BigInt(r.amount), 0n),
  );
  assert.equal(new Set(ledger.map((r) => r.contribution_id)).size, ledger.length);
  assert(ledger.every((r, i) => BigInt(r.sequence) === BigInt(i + 1)));
  pass(
    'All manual commands recover lost completion/restart and fence execute-cancel; ledger reconciles with Fund balance',
  );
  return keys;
}
