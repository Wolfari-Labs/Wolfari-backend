import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  parseUpdateFundBudgetInput,
} = require('../apps/finance-service/dist/inputs/fund-setup.input.js');
const {
  parseCreatePaymentDestinationInput,
  parseUpdatePaymentDestinationInput,
} = require('../apps/finance-service/dist/inputs/payment-destination.input.js');
const {
  FundCommandRepository,
  fundCommandHash,
} = require('../apps/finance-service/dist/repositories/fund-command.repository.js');

export async function runFinanceConfigurationTests(h, helpers) {
  const { request, query, transaction, bearer, pass, waitFor } = h;
  const { owner, holder, outsider } = h.actors;
  const { newTrip, write, enableBody, destination, repo, tripClient, pollTerminal, financeDb } =
    helpers;
  const tripId = await newTrip();
  const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody());
  assert.equal(enabled.status, 201);
  const fundId = enabled.body.data.id,
    base = `/api/v1/funds/${fundId}`;
  const getFund = async () =>
    (await request(`/api/v1/trips/${tripId}/fund`, 'GET', undefined, bearer(owner))).body.data;
  const list = async () =>
    (await request(`${base}/destinations`, 'GET', undefined, bearer(owner))).body.data;
  const send = async (suffix, method, body, user = owner, key = randomUUID()) => {
    const invoke = () =>
      request(`${base}/${suffix}`, method, body, { ...bearer(user), 'idempotency-key': key });
    const response = await invoke();
    if (response.status !== 202) return response;
    await waitFor(async () => {
      const polled = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
      return polled.status === 200 && ['SUCCEEDED', 'FAILED'].includes(polled.body.data.state);
    });
    return invoke();
  };
  const budget = async (amount, user = owner) =>
    send(
      'budget',
      'PATCH',
      {
        budget_amount: amount,
        expected_finance_version: (await getFund()).finance_version,
      },
      user,
    );
  const create = async (config, user = owner) =>
    send(
      'destinations',
      'POST',
      {
        ...config,
        expected_finance_version: (await getFund()).finance_version,
      },
      user,
    );
  const update = async (id, patch, user = owner) =>
    send(
      `destinations/${id}`,
      'PATCH',
      {
        ...patch,
        expected_version: (await list()).find((d) => d.id === id).version,
        expected_finance_version: (await getFund()).finance_version,
      },
      user,
    );
  const confirm = async (id) =>
    send(
      `destinations/${id}/confirm`,
      'POST',
      {
        expected_version: (await list()).find((d) => d.id === id).version,
        expected_finance_version: (await getFund()).finance_version,
      },
      holder,
    );
  const original = (await list())[0];
  for (const user of [holder, outsider]) {
    const status = user === holder ? 403 : 404;
    assert.equal((await budget('100', user)).status, status);
    assert.equal((await create(destination, user)).status, status);
    assert.equal((await update(original.id, { is_default: false }, user)).status, status);
  }
  assert.equal((await send('budget', 'PATCH', { expected_finance_version: 1 })).status, 400);
  assert.equal(
    (
      await send(`destinations/${original.id}`, 'PATCH', {
        active: 'false',
        expected_version: 1,
        expected_finance_version: 1,
      })
    ).status,
    400,
  );
  for (const state of ['CLOSING', 'CLOSED']) {
    await query('finance', 'UPDATE funds SET status=$2 WHERE id=$1', [fundId, state]);
    assert.equal((await budget('100')).status, 409);
    assert.equal((await create(destination)).status, 409);
    assert.equal((await update(original.id, { is_default: false })).status, 409);
  }
  await query('finance', "UPDATE funds SET status='OPEN' WHERE id=$1", [fundId]);
  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [tripId]);
  assert.equal((await budget('100')).status, 409);
  assert.equal((await create(destination)).status, 409);
  assert.equal((await update(original.id, { is_default: false })).status, 409);
  await query('trip', 'UPDATE trips SET archived_at=NULL WHERE id=$1', [tripId]);
  pass(
    'All three configuration APIs enforce Owner, current membership, OPEN Fund and unarchived Trip',
  );

  const key = randomUUID(),
    body = { budget_amount: '9007199254740993', expected_finance_version: 1 };
  const changed = await send('budget', 'PATCH', body, owner, key);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.data.budget_amount, body.budget_amount);
  assert.equal(changed.body.data.finance_version, 2);
  assert.equal(changed.body.data.current_balance, '0');
  const before = await query(
    'finance',
    'SELECT finance_version,updated_at FROM funds WHERE id=$1',
    [fundId],
  );
  assert.equal((await budget(`000${body.budget_amount}`)).status, 200);
  assert.deepEqual(
    await query('finance', 'SELECT finance_version,updated_at FROM funds WHERE id=$1', [fundId]),
    before,
  );
  assert.equal((await budget(null)).body.data.budget_amount, null);
  assert.deepEqual((await send('budget', 'PATCH', body, owner, key)).body.data, changed.body.data);
  assert.equal(
    (await send('budget', 'PATCH', { ...body, budget_amount: '1' }, owner, key)).status,
    409,
  );
  assert.equal((await send('budget', 'PATCH', body)).status, 409);
  await query('finance', 'UPDATE funds SET finance_version=2147483647 WHERE id=$1', [fundId]);
  assert.equal((await budget('1')).status, 409);
  assert.equal((await budget(null)).status, 200);
  await query('finance', 'UPDATE funds SET finance_version=3 WHERE id=$1', [fundId]);
  pass(
    'Budget supports exact int64/null, stable replay and no-op; stale versions and overflow cannot mutate balance',
  );

  assert.equal((await confirm(original.id)).status, 200);
  const originalConfirmed = (await list()).find((d) => d.id === original.id);
  const fv = (await getFund()).finance_version;
  const created = await create({ ...destination, account_number: '000111222333' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const second = created.body.data;
  assert.equal(second.confirmed_by_holder_at, null);
  assert.equal((await getFund()).finance_version, fv + 1);
  let old = (await list()).find((d) => d.id === original.id);
  assert.equal(old.is_default, false);
  assert.equal(old.active, true);
  assert.equal(old.version, originalConfirmed.version + 1);
  assert.equal(old.confirmed_by_holder_at, originalConfirmed.confirmed_by_holder_at);
  const momo = await create({
    destination_type: 'MOMO_SANDBOX',
    momo_phone: '0900000011',
    active: true,
    is_default: true,
  });
  assert.equal(momo.status, 201);
  assert.equal((await list()).filter((d) => d.active && d.is_default).length, 2);
  assert.equal((await update(original.id, { is_default: true })).status, 200);
  old = (await list()).find((d) => d.id === original.id);
  assert.equal(old.confirmed_by_holder_at, originalConfirmed.confirmed_by_holder_at);
  const snapshot = await query('finance', 'SELECT * FROM payment_destinations WHERE id=$1', [
    original.id,
  ]);
  const auditCount = (
    await query('finance', 'SELECT count(*) AS n FROM finance_audit_logs WHERE fund_id=$1', [
      fundId,
    ])
  )[0].n;
  assert.equal((await update(original.id, { is_default: true })).status, 200);
  assert.deepEqual(
    await query('finance', 'SELECT * FROM payment_destinations WHERE id=$1', [original.id]),
    snapshot,
  );
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM finance_audit_logs WHERE fund_id=$1', [
        fundId,
      ])
    )[0].n,
    auditCount,
  );
  pass(
    'Create and PATCH atomically replace same-provider default; other provider and prior confirmation survive; no-op preserves timestamp/audit',
  );

  const disabled = await update(original.id, { active: false });
  assert.equal(disabled.body.data.is_default, false);
  assert.equal(disabled.body.data.confirmed_by_holder_at, originalConfirmed.confirmed_by_holder_at);
  assert.equal((await confirm(original.id)).status, 409);
  const reactivated = await update(original.id, { active: true });
  assert.equal(reactivated.body.data.confirmed_by_holder_at, null);
  assert.equal(reactivated.body.data.is_default, false);
  await confirm(original.id);
  const renamed = await update(original.id, { account_name: 'UPDATED PRIVATE HOLDER' });
  assert.equal(renamed.body.data.confirmed_by_holder_at, null);
  assert.equal((await update(original.id, { destination_type: 'MOMO_SANDBOX' })).status, 409);
  assert.equal((await update(original.id, { momo_phone: '0900000022' })).status, 400);
  assert.equal((await update(original.id, { active: false, is_default: true })).status, 409);
  pass(
    'Deactivate/reactivate and recipient change enforce fresh Holder consent; provider type and incompatible fields are protected',
  );

  // Competing operations may be rejected at the Trip guard or by Finance version, but only one wins.
  const raceVersion = (await getFund()).finance_version;
  const race = await Promise.all(
    [original.id, second.id].map(async (id) =>
      send(`destinations/${id}`, 'PATCH', {
        is_default: true,
        expected_version: (await list()).find((d) => d.id === id).version,
        expected_finance_version: raceVersion,
      }),
    ),
  );
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  let currentDefault = (await list()).find((d) => d.destination_type === 'VIETQR' && d.is_default);
  const currentVersion = currentDefault.version;
  await query('finance', 'UPDATE payment_destinations SET version=2147483647 WHERE id=$1', [
    currentDefault.id,
  ]);
  assert.equal((await create(destination)).status, 409);
  assert.equal((await list()).find((d) => d.id === currentDefault.id).is_default, true);
  await query('finance', 'UPDATE payment_destinations SET version=$2 WHERE id=$1', [
    currentDefault.id,
    currentVersion,
  ]);
  pass(
    'Concurrent default changes have one winner; overflow on the demoted destination leaves the old default intact',
  );

  const prepare = async (scope, rawBody, destinationId) => {
    const parser = {
      UPDATE_FUND_BUDGET: parseUpdateFundBudgetInput,
      CREATE_PAYMENT_DESTINATION: parseCreatePaymentDestinationInput,
      UPDATE_PAYMENT_DESTINATION: parseUpdatePaymentDestinationInput,
    }[scope];
    const intent = {
      scope,
      actor: owner.id,
      tripId,
      fundId,
      ...(destinationId ? { destinationId } : {}),
      body: parser(rawBody),
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
      cancel: {
        operation_id: input.operationId,
        command_scope: scope,
        request_hash: input.hash,
        authorization_context: guard.context,
      },
    };
  };
  const recover = async (prepared) => {
    await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
      prepared.input.operationId,
    ]);
    return pollTerminal(prepared.input.operationId);
  };
  const failed = await prepare('CREATE_PAYMENT_DESTINATION', {
    ...destination,
    expected_finance_version: (await getFund()).finance_version,
  });
  const allBefore = await query(
    'finance',
    'SELECT * FROM payment_destinations WHERE fund_id=$1 ORDER BY id',
    [fundId],
  );
  const fundBefore = await getFund();
  const broken = new FundCommandRepository({
    ...financeDb,
    withTransaction: (work) =>
      transaction('finance', (client) =>
        work({
          query: (sql, args) => {
            if (sql.includes('INSERT INTO payment_destinations'))
              throw new Error('Injected after demotion');
            return client.query(sql, args);
          },
        }),
      ),
  });
  await assert.rejects(() => broken.execute(failed.input, failed.guard, randomUUID()), /Injected/);
  assert.deepEqual(
    await query('finance', 'SELECT * FROM payment_destinations WHERE fund_id=$1 ORDER BY id', [
      fundId,
    ]),
    allBefore,
  );
  assert.deepEqual(await getFund(), fundBefore);
  assert.equal(await repo.find(failed.input.operationId), undefined);
  assert.equal(await recover(failed), 'FAILED');
  pass(
    'Failure after default demotion rolls back all destinations, Fund version, audit and receipt',
  );

  for (const scope of [
    'UPDATE_FUND_BUDGET',
    'CREATE_PAYMENT_DESTINATION',
    'UPDATE_PAYMENT_DESTINATION',
  ]) {
    const raw = {
      expected_finance_version: (await getFund()).finance_version,
      ...(scope === 'UPDATE_FUND_BUDGET'
        ? { budget_amount: '77' }
        : scope === 'CREATE_PAYMENT_DESTINATION'
          ? { ...destination, is_default: false }
          : {
              active: true,
              expected_version: (await list()).find((d) => d.id === original.id).version,
            }),
    };
    const cancelled = await prepare(
      scope,
      raw,
      scope === 'UPDATE_PAYMENT_DESTINATION' ? original.id : undefined,
    );
    assert.equal((await repo.cancel(cancelled.cancel)).status, 'CANCELLED');
    assert.equal(
      (await repo.execute(cancelled.input, cancelled.guard, randomUUID())).status,
      'CANCELLED',
    );
    assert.equal(await recover(cancelled), 'FAILED');
    const committed = await prepare(
      scope,
      raw,
      scope === 'UPDATE_PAYMENT_DESTINATION' ? original.id : undefined,
    );
    const receipt = await repo.execute(committed.input, committed.guard, randomUUID());
    assert.equal(receipt.status, 'COMMITTED');
    assert.equal((await repo.cancel(committed.cancel)).status, 'COMMITTED');
    assert.equal(await recover(committed), 'SUCCEEDED');
    assert.deepEqual(
      (await repo.execute(committed.input, committed.guard, randomUUID())).response,
      receipt.response,
    );
    pass(
      `${scope}: cancellation fences late execution; lost Complete recovers committed receipt and releases guard`,
    );
  }
  // Create replay must be authorized against current private visibility, even though snapshot is stored.
  const replayKey = randomUUID(),
    createBody = {
      ...destination,
      is_default: false,
      expected_finance_version: (await getFund()).finance_version,
    };
  const replayCreated = await send('destinations', 'POST', createBody, owner, replayKey);
  assert.equal(replayCreated.status, 201);
  assert.deepEqual(
    (await send('destinations', 'POST', createBody, owner, replayKey)).body.data,
    replayCreated.body.data,
  );
  await query('trip', "UPDATE trip_members SET role='MEMBER' WHERE trip_id=$1 AND user_id=$2", [
    tripId,
    owner.id,
  ]);
  assert.equal((await send('destinations', 'POST', createBody, owner, replayKey)).status, 404);
  await query('trip', "UPDATE trip_members SET role='OWNER' WHERE trip_id=$1 AND user_id=$2", [
    tripId,
    owner.id,
  ]);
  pass(
    'Create replay preserves the original resource and refuses private data after Owner permission is revoked',
  );
}
