import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runClosureInboxTests(h, s) {
  const { query, request, bearer, waitFor, pass } = h;
  const {
    owner,
    holder,
    member,
    extra,
    setupFund,
    r,
    repository,
    pool,
    inbox,
    notifications,
    processed,
    copied,
    publish,
    awaitDlq,
    broker,
    crashConsumer,
    sourceFingerprint,
    storedEvent,
  } = s;
  const queue = 'wolfari.automation.finance-notifications.v1';
  const all = [owner, holder, member];
  const mutate = async (path, body, user = owner) => {
    const key = randomUUID();
    const invoke = () => request(path, 'POST', body, { ...bearer(user), 'Idempotency-Key': key });
    let response = await invoke();
    if (response.status === 202 && response.body?.data?.operation_id) {
      await waitFor(async () => {
        const result = await request(`/api/v1/operations/${key}`, 'GET', undefined, bearer(user));
        return result.status === 200 && ['SUCCEEDED', 'FAILED'].includes(result.body.data.state);
      });
      response = await invoke();
    }
    return { response, key };
  };
  const eventFor = async (key) => {
    const rows = await query(
      'finance',
      `SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
      FROM outbox_events WHERE operation_id=$1 AND event_type='ClosureRequested'`,
      [key],
    );
    assert.equal(rows.length, 1);
    return storedEvent(rows[0]);
  };
  const createClosure = async (fund) => {
    const [row] = await query('finance', 'SELECT finance_version FROM funds WHERE id=$1', [
      fund.fundId,
    ]);
    const { response, key } = await mutate(`/api/v1/funds/${fund.fundId}/closures`, {
      expected_finance_version: row.finance_version,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { ...fund, closure: response.body.data, event: await eventFor(key) };
  };
  const remind = async (fixture) => {
    const { response, key } = await mutate(`/api/v1/closures/${fixture.closure.id}/remind`, {});
    assert.equal(response.status, 202, JSON.stringify(response.body));
    return eventFor(key);
  };
  const action = async (fixture, name, user = owner) => {
    const { response } = await mutate(
      `/api/v1/closures/${fixture.closure.id}/${name}`,
      name === 'confirm'
        ? { snapshot_hash: fixture.closure.snapshot_hash }
        : { reason: 'Isolated fixture cancellation' },
      user,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  const age = (fixture) =>
    query(
      'automation',
      `UPDATE notifications SET created_at=clock_timestamp()-interval '24 hours'
    WHERE type='CLOSURE_REQUESTED' AND source_id=$1`,
      [fixture.closure.id],
    );
  const assertRecipients = async (event, expected) =>
    assert.deepEqual(
      (await notifications(event)).map((row) => row.user_id).sort(),
      expected.map((user) => user.id).sort(),
    );

  const fixture = await createClosure(await setupFund());
  await processed(fixture.event);
  await assertRecipients(fixture.event, all);
  for (const row of await notifications(fixture.event)) {
    assert.equal(row.type, 'CLOSURE_REQUESTED');
    assert.equal(row.status, 'AVAILABLE');
    assert.equal(row.source_id, fixture.closure.id);
    assert.equal(row.recipient_email, null);
    for (const secret of ['PRIVATE', '123456', '000987654321', fixture.closure.snapshot_hash])
      assert(!JSON.stringify(row).includes(secret));
  }
  assert.equal(
    (
      await query(
        'automation',
        `SELECT count(*)::int AS n FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.event_id=$1`,
        [fixture.event.event_id],
      )
    )[0].n,
    0,
  );
  const page = await request('/api/v1/me/notifications', 'GET', undefined, bearer(owner));
  assert.equal(page.status, 200);
  assert(
    JSON.stringify(page.body).includes(
      (await notifications(fixture.event)).find((row) => row.user_id === owner.id).id,
    ),
  );
  pass(
    'Closure API120 -> outbox -> current CLOSING audience -> Self inbox, including Owner and preferences off with generic content',
  );

  const early = await remind(fixture);
  await processed(early);
  assert.equal(early.aggregate_version, fixture.event.aggregate_version);
  assert.notEqual(early.event_id, fixture.event.event_id);
  await assertRecipients(early, []);
  assert.equal((await inbox(early))[0].result.cooldown_suppressed, 3);
  await query(
    'automation',
    `UPDATE notifications SET created_at=clock_timestamp()-interval '24 hours' WHERE event_id=$1 AND user_id=$2`,
    [fixture.event.event_id, owner.id],
  );
  await query(
    'automation',
    `UPDATE notifications SET created_at=clock_timestamp()-interval '23 hours 59 minutes' WHERE event_id=$1 AND user_id=$2`,
    [fixture.event.event_id, member.id],
  );
  const later = await remind(fixture);
  await processed(later);
  await assertRecipients(later, [owner]);
  assert.equal((await inbox(later))[0].result.cooldown_suppressed, 2);
  await age(fixture);
  assert.equal(
    await repository.complete(
      r.financeNotificationEvent(early),
      all.map((user) => user.id),
    ),
    'DUPLICATE',
  );
  await assertRecipients(early, []);
  pass(
    'explicit reminders retain distinct IDs at the same version; per-user rolling 24-hour limit and suppressed replay remain durable',
  );

  await action(fixture, 'confirm', owner);
  const concurrent = [];
  await h.whileServiceStopped('automation-service', async () => {
    for (let i = 0; i < 8; i++) concurrent.push(await remind(fixture));
  });
  await Promise.all(concurrent.map(processed));
  const emitted = (await Promise.all(concurrent.map(notifications))).flat();
  assert.deepEqual(emitted.map((row) => row.user_id).sort(), [holder.id, member.id].sort());
  assert(concurrent.every((event) => event.aggregate_version === concurrent[0].aggregate_version));
  pass(
    'eight concurrent reminder events create one notice per remaining unconfirmed user without Fund-version deduplication',
  );

  const immutable = await sourceFingerprint();
  await Promise.all(Array.from({ length: 12 }, () => publish(later)));
  assert.equal(await repository.complete(r.financeNotificationEvent(later), []), 'DUPLICATE');
  assert.deepEqual(await sourceFingerprint(), immutable);
  const collision = { ...later, payload: { ...later.payload, snapshot_hash: 'b'.repeat(64) } };
  await publish(collision);
  await awaitDlq(collision);
  const malformed = { ...copied(later), payload: { ...later.payload, snapshot_hash: 'bad' } };
  await publish(malformed);
  await awaitDlq(malformed);
  assert.equal((await inbox(malformed)).length, 0);
  pass('closure replay preserves source data and changed/malformed snapshot identity goes to DLQ');

  await action(fixture, 'cancel');
  const replacement = await createClosure(fixture);
  await processed(replacement.event);
  await assertRecipients(replacement.event, all);
  const stale = copied(fixture.event);
  await publish(stale);
  await processed(stale);
  await assertRecipients(stale, []);
  pass(
    'a new closure has independent cooldown; delayed events for the cancelled old closure cannot create notices',
  );

  for (const mode of [
    'confirmed-owner',
    'cancelled',
    'completed',
    'archived',
    'rejoined',
    'locked',
  ]) {
    let delayed;
    await h.whileServiceStopped('automation-service', async () => {
      delayed = await createClosure(await setupFund());
      if (mode === 'confirmed-owner') await action(delayed, 'confirm', owner);
      if (mode === 'cancelled') await action(delayed, 'cancel');
      if (mode === 'completed') for (const user of all) await action(delayed, 'confirm', user);
      if (mode === 'archived')
        await query('trip', 'UPDATE trips SET archived_at=clock_timestamp() WHERE id=$1', [
          delayed.tripId,
        ]);
      if (mode === 'rejoined') {
        await query(
          'trip',
          'UPDATE trip_members SET left_at=clock_timestamp() WHERE trip_id=$1 AND user_id=$2',
          [delayed.tripId, member.id],
        );
        await query(
          'trip',
          "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',clock_timestamp())",
          [delayed.tripId, member.id],
        );
      }
      if (mode === 'locked')
        await query('identity', "UPDATE users SET status='LOCKED' WHERE id=$1", [member.id]);
    });
    await processed(delayed.event);
    await assertRecipients(
      delayed.event,
      mode === 'confirmed-owner'
        ? [holder, member]
        : ['locked', 'rejoined'].includes(mode)
          ? [owner, holder]
          : [],
    );
    if (mode === 'locked')
      await query('identity', "UPDATE users SET status='ACTIVE' WHERE id=$1", [member.id]);
    pass(`current closure context/account filters delayed ${mode} source`);
  }

  const batch = await createClosure(await setupFund([owner, holder, ...extra]));
  await processed(batch.event);
  await assertRecipients(batch.event, [owner, holder, ...extra]);
  pass(
    '103 closure snapshot recipients are checked in multiple Identity batches and committed atomically',
  );

  const atomic = {
    ...copied(replacement.event),
    payload: { ...replacement.event.payload, closure_id: randomUUID() },
  };
  const projected = r.financeNotificationEvent(atomic);
  await assert.rejects(
    repository.complete(
      { ...projected, tripId: 'invalid' },
      all.map((user) => user.id),
    ),
  );
  assert.equal((await inbox(atomic)).length, 0);
  await assertRecipients(atomic, []);
  const held = await pool.connect();
  try {
    await held.query('BEGIN');
    await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `finance-closure-notice:${projected.closureId}:${owner.id}`,
    ]);
    const started = Date.now();
    await assert.rejects(
      repository.complete(
        projected,
        all.map((user) => user.id),
      ),
    );
    assert(Date.now() - started < 8000);
    assert.equal((await inbox(atomic)).length, 0);
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  await repository.complete(
    projected,
    all.map((user) => user.id),
  );
  await assertRecipients(atomic, all);
  pass(
    'failed closure insert or timed-out cooldown lock rolls back inbox; the same event can safely retry',
  );

  const isolationSource = randomUUID();
  const contenders = Array.from({ length: 2 }, () => ({
    ...copied(replacement.event),
    payload: { ...replacement.event.payload, closure_id: isolationSource },
  }));
  const gate = await pool.connect();
  const sessions = await Promise.all([pool.connect(), pool.connect()]);
  const waiting = new Set();
  let race;
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `finance-closure-notice:${isolationSource}:${owner.id}`,
    ]);
    for (const session of sessions)
      await session.query("SET default_transaction_isolation='repeatable read'");
    race = Promise.all(
      sessions.map((session, index) => {
        const contender = new r.FinanceNotificationRepository({
          pool: {
            connect: async () => ({
              query: (config) => {
                if (config.text.includes('pg_advisory_xact_lock')) waiting.add(index);
                return session.query(config);
              },
              release: () => {}, // The fixture owns these sessions until both transactions finish.
            }),
          },
        });
        return contender.complete(r.financeNotificationEvent(contenders[index]), [owner.id]);
      }),
    );
    race.catch(() => {});
    await waitFor(() => waiting.size === 2, 3000);
    await gate.query('COMMIT');
    await race;
    const created = (await Promise.all(contenders.map(notifications))).flat();
    assert.equal(created.length, 1);
    assert.deepEqual(
      (await Promise.all(contenders.map(inbox))).map((rows) => rows[0].result.count).sort(),
      [0, 1],
    );
  } finally {
    await gate.query('ROLLBACK').catch(() => {});
    await race?.catch(() => {});
    gate.release();
    for (const session of sessions) session.release(true);
  }
  pass('two blocked competing events preserve cooldown even with REPEATABLE READ session defaults');

  for (const dependency of ['finance-service', 'identity-service']) {
    await age(replacement);
    const retry = copied(replacement.event);
    await h.whileServiceStopped(dependency, async () => {
      await publish(retry);
      await waitFor(
        async () => (await (await broker()).checkQueue(`${queue}.retry.0`)).messageCount > 0,
      );
      assert.equal((await inbox(retry)).length, 0);
    });
    await processed(retry);
    await assertRecipients(retry, all);
    pass(`closure ${dependency} outage retries without partial inbox or consuming cooldown`);
  }

  await age(replacement);
  const exhausted = copied(replacement.event);
  let retained;
  await h.whileServiceStopped('finance-service', async () => {
    await publish(exhausted, { 'x-finance-notification-attempt': 5 });
    retained = await awaitDlq(exhausted);
    assert.equal((await inbox(exhausted)).length, 0);
  });
  assert.deepEqual(retained.body, exhausted);
  await publish(retained.body);
  await processed(exhausted);
  await assertRecipients(exhausted, all);
  pass('closure DLQ replay keeps its event ID and applies a single eligible notification set');

  await age(replacement);
  await crashConsumer(copied(replacement.event), 3);
  pass(
    'closure commit-before-ACK process death redelivers without bypassing deduplication or cooldown',
  );

  await age(replacement);
  const persisted = copied(replacement.event);
  await h.whileServiceStopped('automation-service', async () => {
    await publish(persisted);
    await h.restartBroker();
    await waitFor(async () => (await (await broker()).checkQueue(queue)).messageCount >= 1, 30_000);
  });
  await processed(persisted);
  await assertRecipients(persisted, all);
  pass(
    'closure notification survives broker restart with original identity and current audience revalidation',
  );
}
