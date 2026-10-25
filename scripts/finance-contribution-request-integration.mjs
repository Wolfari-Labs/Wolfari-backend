import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runContributionReadTests } from './finance-contribution-read-integration.mjs';
const require = createRequire(import.meta.url);
const {
  parseCreateContributionRequestInput,
} = require('../apps/finance-service/dist/inputs/create-contribution-request.input.js');
const {
  FundCommandRepository,
  fundCommandHash,
} = require('../apps/finance-service/dist/repositories/fund-command.repository.js');

export async function runContributionRequestTests(h, helpers) {
  const { request, query, transaction, bearer, pass } = h;
  const { owner, holder, outsider, member } = h.actors;
  const { newTrip, write, enableBody, repo, tripClient, pollTerminal, financeDb } = helpers;
  const tripId = await newTrip();
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
    [tripId, member.id],
  );
  const enabled = await write(`/api/v1/trips/${tripId}/fund`, enableBody());
  assert.equal(enabled.status, 201);
  const fundId = enabled.body.data.id,
    path = `/api/v1/funds/${fundId}/contribution-requests`;
  const fund = async () => (await query('finance', 'SELECT * FROM funds WHERE id=$1', [fundId]))[0];
  const dest = (
    await query('finance', 'SELECT * FROM payment_destinations WHERE fund_id=$1', [fundId])
  )[0];
  const body = async () => ({
    title: 'Shared meals',
    contributions: [
      { member_user_id: member.id, amount: '9007199254740993', destination_id: dest.id },
      { member_user_id: holder.id, amount: '300000', destination_id: dest.id },
    ],
    expected_finance_version: (await fund()).finance_version,
  });
  const send = (data, user = owner, key = randomUUID()) => write(path, data, user, key);
  assert.equal((await request(path, 'POST', await body())).status, 401);
  assert.equal((await request(path, 'POST', await body(), bearer(owner))).status, 400);
  for (const user of [holder, member, outsider])
    assert.equal((await send(await body(), user)).status, user === outsider ? 404 : 403);
  assert.equal((await send(await body())).status, 400); // destination unconfirmed
  const confirmed = await write(
    `/api/v1/funds/${fundId}/destinations/${dest.id}/confirm`,
    { expected_version: 1, expected_finance_version: 1 },
    holder,
  );
  assert.equal(confirmed.status, 200);
  for (const patch of [
    { contributions: [] },
    { actor_user_id: owner.id },
    { due_at: null },
    { due_at: '2026-02-30T00:00:00Z' },
    { contributions: [{ member_user_id: member.id, amount: 2, destination_id: dest.id }] },
    { contributions: [{ member_user_id: member.id, amount: '0', destination_id: dest.id }] },
    {
      contributions: [
        { member_user_id: member.id, amount: '9223372036854775808', destination_id: dest.id },
      ],
    },
  ])
    assert.equal((await send({ ...(await body()), ...patch })).status, 400);
  const duplicate = await body();
  duplicate.contributions.push({ ...duplicate.contributions[0] });
  assert.equal((await send(duplicate)).status, 400);
  const missingMember = await body();
  missingMember.contributions[0].member_user_id = outsider.id;
  assert.equal((await send(missingMember)).status, 400);
  const otherTrip = await newTrip();
  const otherFund = await write(`/api/v1/trips/${otherTrip}/fund`, enableBody());
  const otherDest = (
    await query('finance', 'SELECT id FROM payment_destinations WHERE fund_id=$1', [
      otherFund.body.data.id,
    ])
  )[0];
  const cross = await body();
  cross.contributions[0].destination_id = otherDest.id;
  assert.equal((await send(cross)).status, 400);
  await query('finance', 'UPDATE payment_destinations SET active=false WHERE id=$1', [dest.id]);
  assert.equal((await send(await body())).status, 400);
  await query('finance', 'UPDATE payment_destinations SET active=true WHERE id=$1', [dest.id]);
  pass('API078 validates session, Owner, members, amounts and confirmed same-Fund destinations');

  const key = randomUUID(),
    raw = { ...(await body()), due_at: '2026-10-20T07:00:00+07:00', note: '' };
  const before = await fund(),
    created = await send(raw, owner, key);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const result = created.body.data;
  assert.equal(result.finance_version, before.finance_version + 1);
  assert.equal(result.contributions.length, 2);
  assert.equal(result.contributions[0].amount, '9007199254740993');
  assert.equal(result.status, 'OPEN');
  assert.equal(result.version, 1);
  assert.equal(result.due_at, '2026-10-20T00:00:00.000Z');
  assert.equal(result.note, '');
  assert.equal(result.amount_per_member, null);
  assert.equal(result.created_by_user_id, owner.id);
  const rows = await query(
    'finance',
    'SELECT * FROM contributions WHERE request_id=$1 ORDER BY member_user_id',
    [result.id],
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'PENDING');
    assert.equal(row.version, 1);
    assert.equal(
      row.amount,
      raw.contributions.find((c) => c.member_user_id === row.member_user_id).amount,
    );
    assert.equal(row.self_contribution, row.member_user_id === holder.id);
    assert.equal(row.destination_version, 2);
    assert.equal(row.destination_snapshot.schema_version, 1);
    assert.equal(row.destination_snapshot.destination_version, 2);
    assert.equal(row.destination_snapshot.holder_user_id, holder.id);
    assert.equal(row.destination_snapshot.recipient.account_number, dest.account_number);
    assert.equal(row.destination_snapshot.destination_id, dest.id);
    assert.equal(row.destination_snapshot.fund_id, fundId);
    assert(!('active' in row.destination_snapshot));
  }
  assert.equal((await fund()).current_balance, before.current_balance);
  assert.equal((await fund()).finance_version, before.finance_version + 1);
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM fund_transactions WHERE fund_id=$1', [
        fundId,
      ])
    )[0].n,
    '0',
  );
  const events = await query('finance', 'SELECT * FROM outbox_events WHERE operation_id=$1', [key]);
  assert.equal(events.length, 1);
  const event = events[0];
  const { validateEventForPublish } = require('../packages/contracts/dist/events.js');
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
    ].map((key) => [key, event[key]]),
  );
  validateEventForPublish({ ...envelope, occurred_at: event.occurred_at.toISOString() });
  assert.equal(event.event_type, 'ContributionRequested');
  assert.equal(event.producer, 'Finance');
  assert.equal(event.aggregate_type, 'Fund');
  assert.equal(event.status, 'PENDING');
  assert.equal(event.schema_version, 1);
  assert.equal(event.aggregate_version, before.finance_version + 1);
  assert.deepEqual(event.payload, {
    fund_id: fundId,
    trip_id: tripId,
    request_id: result.id,
    contribution_ids: raw.contributions.map(
      (c) => rows.find((row) => row.member_user_id === c.member_user_id).id,
    ),
    finance_version: before.finance_version + 1,
  });
  const after = await fund();
  assert.deepEqual((await send(raw, owner, key)).body.data, result);
  assert.deepEqual(await fund(), after);
  assert.equal((await send({ ...raw, due_at: '2026-10-21T00:00:00Z' }, owner, key)).status, 409);
  assert.equal((await send({ ...raw, title: 'Different' }, owner, key)).status, 409);
  assert.equal((await send(raw)).status, 409); // different key, stale version
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM outbox_events WHERE operation_id=$1', [key])
    )[0].n,
    '1',
  );
  const serialized = JSON.stringify([result, event.payload, (await repo.find(key)).response]);
  assert(!serialized.includes(dest.account_number));
  assert(!serialized.includes('destination_snapshot'));
  pass(
    'API078 atomically creates PENDING allocations, exact money, immutable receipt and one privacy-safe outbox event without ledger',
  );

  // Configuration changes must not rewrite the already-issued payment instruction.
  const update = await request(
    `/api/v1/funds/${fundId}/destinations/${dest.id}`,
    'PATCH',
    {
      account_name: 'CHANGED RECIPIENT',
      expected_version: 2,
      expected_finance_version: (await fund()).finance_version,
    },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assert.equal(update.status, 200);
  assert.deepEqual(
    await query(
      'finance',
      'SELECT * FROM contributions WHERE request_id=$1 ORDER BY member_user_id',
      [result.id],
    ),
    rows,
  );
  assert.equal((await send(await body())).status, 400);
  assert.equal(
    (
      await write(
        `/api/v1/funds/${fundId}/destinations/${dest.id}/confirm`,
        { expected_version: 3, expected_finance_version: (await fund()).finance_version },
        holder,
      )
    ).status,
    200,
  );
  for (const state of ['CLOSING', 'CLOSED']) {
    await query('finance', 'UPDATE funds SET status=$2 WHERE id=$1', [fundId, state]);
    assert.equal((await send(await body())).status, 409);
  }
  await query('finance', "UPDATE funds SET status='OPEN' WHERE id=$1", [fundId]);
  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [tripId]);
  assert.equal((await send(await body())).status, 409);
  await query('trip', 'UPDATE trips SET archived_at=NULL WHERE id=$1', [tripId]);
  await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    member.id,
  ]);
  assert.equal((await send(await body())).status, 400);
  await query('trip', 'UPDATE trip_members SET left_at=NULL WHERE trip_id=$1 AND user_id=$2', [
    tripId,
    member.id,
  ]);
  const v = (await fund()).finance_version;
  await query('finance', 'UPDATE funds SET finance_version=2147483647 WHERE id=$1', [fundId]);
  assert.equal((await send(await body())).status, 409);
  await query('finance', 'UPDATE funds SET finance_version=$2 WHERE id=$1', [fundId, v]);
  pass('API078 preserves issued snapshots and rejects closed/archived/departed/overflow writes');

  const concurrentBody = await body();
  const competing = await Promise.all([send(concurrentBody), send(concurrentBody)]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  const sameKey = randomUUID(),
    sameBody = await body();
  const same = await Promise.all([send(sameBody, owner, sameKey), send(sameBody, owner, sameKey)]);
  assert(same.every((r) => r.status === 201));
  assert.equal(same[0].body.data.id, same[1].body.data.id);
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM outbox_events WHERE operation_id=$1', [
        sameKey,
      ])
    )[0].n,
    '1',
  );
  pass('API078 concurrent requests serialize versions and same-key retries create one request');

  const prepare = async () => {
    const data = await body();
    const intent = {
      scope: 'CREATE_CONTRIBUTION_REQUEST',
      actor: owner.id,
      tripId,
      fundId,
      body: parseCreateContributionRequestInput(data),
    };
    const input = { ...intent, operationId: randomUUID(), hash: fundCommandHash(intent) };
    const guard = await tripClient.call(
      'BeginFinanceOperation',
      {
        operation_id: input.operationId,
        trip_id: tripId,
        actor: { actor_user_id: owner.id },
        command: input.scope,
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
        command_scope: input.scope,
        request_hash: input.hash,
        authorization_context: guard.context,
      },
      data,
    };
  };
  const recover = async (p) => {
    await query('trip', 'UPDATE trip_operations SET next_retry_at=now() WHERE operation_id=$1', [
      p.input.operationId,
    ]);
    return pollTerminal(p.input.operationId);
  };
  const snapshot = async () => {
    const data = { fund: await fund() };
    for (const table of ['contribution_requests', 'contributions', 'finance_audit_logs'])
      data[table] = await query('finance', `SELECT * FROM ${table} WHERE fund_id=$1 ORDER BY id`, [
        fundId,
      ]);
    data.outbox = await query(
      'finance',
      'SELECT * FROM outbox_events WHERE aggregate_id=$1 ORDER BY event_id',
      [fundId],
    );
    return data;
  };
  for (const failAt of ['second allocation', 'outbox', 'receipt']) {
    const p = await prepare(),
      saved = await snapshot();
    let allocations = 0;
    const broken = new FundCommandRepository({
      ...financeDb,
      withTransaction: (work) =>
        transaction('finance', (client) =>
          work({
            query: (sql, args) => {
              if (sql.includes('INSERT INTO contributions(')) allocations++;
              if (
                (failAt === 'second allocation' &&
                  allocations === 2 &&
                  sql.includes('INSERT INTO contributions(')) ||
                (failAt === 'outbox' && sql.includes('INSERT INTO outbox_events')) ||
                (failAt === 'receipt' && sql.includes('INSERT INTO command_receipts'))
              )
                throw new Error('Injected request failure');
              return client.query(sql, args);
            },
          }),
        ),
    });
    await assert.rejects(() => broken.execute(p.input, p.guard, randomUUID()), /Injected/);
    assert.deepEqual(await snapshot(), saved);
    assert.equal(await repo.find(p.input.operationId), undefined);
    assert.equal(await recover(p), 'FAILED');
  }
  pass('API078 failures during allocation, outbox or receipt roll back all business effects');

  const cancelled = await prepare();
  // Same Trip guard blocks configuration and membership changes until terminal outcome.
  assert.equal(
    (
      await request(
        `/api/v1/funds/${fundId}/budget`,
        'PATCH',
        { budget_amount: '4', expected_finance_version: (await fund()).finance_version },
        { ...bearer(owner), 'idempotency-key': randomUUID() },
      )
    ).status,
    409,
  );
  const {
    MembershipRepository,
  } = require('../apps/trip-workspace-service/dist/membership/membership.repository.js');
  const memberships = new MembershipRepository({
    withTransaction: (work) => transaction('trip', work),
  });
  const revision = (
    await query('trip', 'SELECT membership_revision FROM trips WHERE id=$1', [tripId])
  )[0].membership_revision;
  await assert.rejects(
    () =>
      memberships.prepare(
        {
          operationId: randomUUID(),
          actorUserId: member.id,
          tripId,
          reason: 'Contribution guard test',
          expectedRevision: revision,
          command: 'LEAVE_MEMBER',
        },
        randomUUID(),
        true,
      ),
    (error) => error.code === 'STATE_CONFLICT',
  );
  assert.equal((await repo.cancel(cancelled.cancel)).status, 'CANCELLED');
  assert.equal(
    (await repo.execute(cancelled.input, cancelled.guard, randomUUID())).status,
    'CANCELLED',
  );
  assert.equal(await recover(cancelled), 'FAILED');
  const committed = await prepare();
  const receipt = await repo.execute(committed.input, committed.guard, randomUUID());
  assert.equal(receipt.status, 'COMMITTED');
  assert.equal((await repo.cancel(committed.cancel)).status, 'COMMITTED');
  await h.restartTrip();
  assert.equal(await recover(committed), 'SUCCEEDED');
  assert.deepEqual(
    (await send(committed.data, owner, committed.input.operationId)).body.data.id,
    receipt.response.contributionRequest.id,
  );
  const race = await prepare();
  const raced = await Promise.all([
    repo.execute(race.input, race.guard, randomUUID()),
    repo.cancel(race.cancel),
  ]);
  assert.equal(raced[0].status, raced[1].status);
  await recover(race);
  pass(
    'API078 guard fences competing changes; cancellation, lost Complete/restart and execute-cancel races recover safely',
  );

  await query(
    'trip',
    "UPDATE trip_members SET role='MEMBER',left_at=now() WHERE trip_id=$1 AND user_id=$2",
    [tripId, owner.id],
  );
  assert.equal((await send(raw, owner, key)).status, 404);
  await query(
    'trip',
    "UPDATE trip_members SET role='OWNER',left_at=NULL WHERE trip_id=$1 AND user_id=$2",
    [tripId, owner.id],
  );
  const intents = await query(
    'trip',
    "SELECT command_payload,outcome FROM trip_operations WHERE trip_id=$1 AND operation_type='CREATE_CONTRIBUTION_REQUEST'",
    [tripId],
  );
  const audits = await query('finance', 'SELECT details FROM finance_audit_logs WHERE fund_id=$1', [
    fundId,
  ]);
  for (const value of [intents, audits])
    assert(!JSON.stringify(value).includes(dest.account_number));
  assert.equal(
    (
      await query('finance', 'SELECT count(*) AS n FROM fund_transactions WHERE fund_id=$1', [
        fundId,
      ])
    )[0].n,
    '0',
  );
  pass(
    'API078 replay rechecks current membership; intents/audit do not expose bank details and no request creates ledger',
  );
  await runContributionReadTests(h, {
    fundId,
    tripId,
    emptyFundId: otherFund.body.data.id,
    created: result,
    replay: () => send(raw, owner, key),
    operationId: key,
  });
}
