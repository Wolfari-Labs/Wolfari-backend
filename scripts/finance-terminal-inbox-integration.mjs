import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runTerminalInboxTests(h, s) {
  const { query, request, bearer, waitFor, pass } = h;
  const {
    owner,
    holder,
    member,
    setupFund,
    createRequest,
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
    assert([200, 201].includes(response.status), JSON.stringify(response.body));
    return { response, key };
  };
  const eventFor = async (key, type) => {
    const rows = await query(
      'finance',
      `SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
       FROM outbox_events WHERE operation_id=$1 AND event_type=$2`,
      [key, type],
    );
    assert.equal(rows.length, 1);
    return storedEvent(rows[0]);
  };
  const closure = async (fund = undefined) => {
    fund ??= await setupFund();
    const [row] = await query('finance', 'SELECT finance_version FROM funds WHERE id=$1', [
      fund.fundId,
    ]);
    const { response, key } = await mutate(`/api/v1/funds/${fund.fundId}/closures`, {
      expected_finance_version: row.finance_version,
    });
    return { ...fund, closure: response.body.data, event: await eventFor(key, 'ClosureRequested') };
  };
  const cancel = async (fixture) => {
    const { key } = await mutate(`/api/v1/closures/${fixture.closure.id}/cancel`, {
      reason: 'Isolated terminal fixture',
    });
    return eventFor(key, 'ClosureCancelled');
  };
  const closed = async (fixture) => {
    let key;
    for (const user of [owner, holder, member])
      ({ key } = await mutate(
        `/api/v1/closures/${fixture.closure.id}/confirm`,
        { snapshot_hash: fixture.closure.snapshot_hash },
        user,
      ));
    return eventFor(key, 'FinanceClosed');
  };
  // Synthetic envelopes are confined to this isolated fixture for ordering/fault probes.
  const synthetic = (
    type,
    fund = randomUUID(),
    trip = randomUUID(),
    source = randomUUID(),
    version = 10,
  ) => ({
    event_id: randomUUID(),
    event_type: type,
    schema_version: 1,
    producer: 'Finance',
    aggregate_type: 'Fund',
    aggregate_id: fund,
    aggregate_version: version,
    trip_id: trip,
    correlation_id: randomUUID(),
    operation_id: null,
    actor_user_id: owner.id,
    causation_id: null,
    system_actor: null,
    occurred_at: '2026-10-29T03:00:00.123456Z',
    payload: {
      fund_id: fund,
      trip_id: trip,
      finance_version: version,
      ...(type === 'ContributionRequested'
        ? { request_id: source, contribution_ids: [randomUUID()] }
        : type === 'ContributionUpdated'
          ? { contribution_id: source, status: 'TRANSFER_REPORTED' }
          : {
              closure_id: source,
              ...(type === 'ClosureRequested' ? { snapshot_hash: 'a'.repeat(64) } : {}),
            }),
    },
  });
  const apply = (event, users = [], revision) =>
    repository.complete(r.financeNotificationEvent(event), users, revision);
  const suppressed = async (event, users = [owner.id], revision) => {
    await apply(event, users, revision);
    assert.equal((await notifications(event)).length, 0);
    const [row] = await inbox(event);
    assert.equal(row.result.outcome, 'SUPPRESSED');
    assert.equal(row.result.terminal_suppressed, users.length);
    assert.equal(row.result.cooldown_suppressed ?? row.result.duplicate_suppressed ?? 0, 0);
  };

  const cancelled = await closure();
  await processed(cancelled.event);
  const oldHistory = await notifications(cancelled.event);
  assert.equal(oldHistory.length, 3);
  const cancelledEvent = await cancel(cancelled);
  await processed(cancelledEvent);
  assert.equal((await inbox(cancelledEvent))[0].result.outcome, 'TERMINAL');
  assert.equal((await notifications(cancelledEvent)).length, 0);
  await suppressed(copied(cancelled.event));
  assert.deepEqual(await notifications(cancelled.event), oldHistory);
  pass(
    'real API124 cancellation/outbox creates a terminal barrier, suppresses stale recipients and preserves delivered history',
  );

  const replacement = await closure(cancelled);
  await processed(replacement.event);
  assert.equal((await notifications(replacement.event)).length, 3);
  await publish(copied(cancelledEvent));
  const cancelReplacement = await cancel(replacement);
  await processed(cancelReplacement);
  const requestAfterCancel = await createRequest(cancelled, [owner]);
  await processed(requestAfterCancel);
  assert.equal((await notifications(requestAfterCancel)).length, 1);
  pass(
    'late cancellation targets only its closure; replacement closure and new OPEN Fund request still notify',
  );

  const finished = await closure();
  await processed(finished.event);
  const finishedHistory = await notifications(finished.event);
  const finishedEvent = await closed(finished);
  await processed(finishedEvent);
  for (const type of ['ContributionRequested', 'ContributionUpdated', 'ClosureRequested'])
    await suppressed(
      synthetic(type, finished.fundId, finished.tripId, randomUUID(), 1),
      [owner.id],
      type === 'ContributionUpdated' ? 1 : undefined,
    );
  assert.deepEqual(await notifications(finished.event), finishedHistory);
  assert.equal((await notifications(finishedEvent)).length, 0);
  pass(
    'real API123 completion/outbox blocks all three stale Finance notice types while preserving history',
  );

  const sourceBefore = await sourceFingerprint();
  const stopped = synthetic('FinanceClosed');
  await apply(stopped);
  for (const version of [1, stopped.aggregate_version, 999])
    await suppressed(
      synthetic(
        'ContributionRequested',
        stopped.aggregate_id,
        stopped.trip_id,
        randomUUID(),
        version,
      ),
    );
  const independent = synthetic('ContributionRequested');
  await apply(independent, [owner.id]);
  assert.equal((await notifications(independent)).length, 1);
  assert.deepEqual(await sourceFingerprint(), sourceBefore);
  pass(
    'terminal barrier is monotonic across old/new event versions, isolated by Fund and never writes source databases',
  );

  const inflight = synthetic('ContributionRequested');
  const stopInflight = synthetic('FinanceClosed', inflight.aggregate_id, inflight.trip_id);
  let reads = 0;
  const service = new r.FinanceNotificationService(
    {
      getContext: async () => {
        if (++reads === 2) await apply(stopInflight);
        return { finance_version: 10, status: 1, authorized_recipients: [{ user_id: owner.id }] };
      },
      getEligibility: async () => ({ recipients: [{ user_id: owner.id, eligible: true }] }),
    },
    repository,
  );
  await service.process(r.financeNotificationEvent(inflight));
  assert.equal(reads, 2);
  assert.equal((await notifications(inflight)).length, 0);
  assert.equal((await inbox(inflight))[0].result.terminal_suppressed, 1);
  pass(
    'terminal committed during an in-flight source read suppresses stale accepted context at the local transaction',
  );

  // Pause a real transaction immediately before COMMIT to prove a waiting contender
  // observes its barrier even if the connection defaults to REPEATABLE READ.
  const race = synthetic('FinanceClosed');
  const stale = synthetic('ContributionRequested', race.aggregate_id, race.trip_id);
  let reached = false,
    unlock;
  const gate = new Promise((resolve) => {
    unlock = resolve;
  });
  const pausing = new r.FinanceNotificationRepository({
    pool: {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (config) => {
            if (config.text === 'COMMIT') {
              reached = true;
              await gate;
            }
            return client.query(config);
          },
          release: (failed) => client.release(failed),
        };
      },
    },
  });
  let waitingPid;
  const waiting = new r.FinanceNotificationRepository({
    pool: {
      connect: async () => {
        const client = await pool.connect();
        await client.query(
          'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        );
        waitingPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return { query: (config) => client.query(config), release: () => client.release(true) };
      },
    },
  });
  const first = pausing.complete(r.financeNotificationEvent(race), []);
  let second;
  try {
    await waitFor(() => reached);
    second = waiting.complete(r.financeNotificationEvent(stale), [owner.id]);
    await waitFor(
      async () =>
        waitingPid &&
        (
          await query('automation', 'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [
            waitingPid,
          ])
        )[0].blocked,
    );
  } finally {
    unlock();
    await Promise.all([first, second]);
  }
  assert.equal((await notifications(stale)).length, 0);
  assert.equal((await inbox(stale))[0].result.terminal_suppressed, 1);
  pass(
    'real concurrent Fund lock serializes terminal commit before stale insertion with a fresh READ COMMITTED snapshot',
  );

  const beforeTerminal = synthetic('ClosureRequested');
  await apply(beforeTerminal, [owner.id]);
  const afterNotice = synthetic(
    'ClosureCancelled',
    beforeTerminal.aggregate_id,
    beforeTerminal.trip_id,
    beforeTerminal.payload.closure_id,
  );
  await apply(afterNotice);
  assert.equal((await notifications(beforeTerminal)).length, 1);
  await suppressed(copied(beforeTerminal));
  pass(
    'notification committed first remains history; subsequent cancellation blocks later attempts',
  );

  const rollback = synthetic('FinanceClosed');
  const failing = new r.FinanceNotificationRepository({
    pool: {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (config) => {
            if (config.text === 'COMMIT') throw new Error('INJECTED_BEFORE_COMMIT');
            return client.query(config);
          },
          release: (failed) => client.release(failed),
        };
      },
    },
  });
  await assert.rejects(
    failing.complete(r.financeNotificationEvent(rollback), []),
    /INJECTED_BEFORE_COMMIT/,
  );
  assert.equal((await inbox(rollback)).length, 0);
  const allowed = synthetic('ContributionRequested', rollback.aggregate_id, rollback.trip_id);
  await apply(allowed, [owner.id]);
  assert.equal((await notifications(allowed)).length, 1);
  await apply(rollback);
  await suppressed(copied(allowed));
  pass(
    'failure before terminal COMMIT rolls back the barrier and inbox together; retry restores the barrier',
  );

  const timeout = synthetic('FinanceClosed');
  const held = await pool.connect();
  try {
    await held.query('BEGIN');
    await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `finance-notification-fund:${timeout.aggregate_id}`,
    ]);
    const started = Date.now();
    await assert.rejects(apply(timeout));
    assert(Date.now() - started < 8000);
    assert.equal((await inbox(timeout)).length, 0);
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  await apply(timeout);
  assert.equal((await inbox(timeout))[0].result.outcome, 'TERMINAL');
  pass('held Fund lock times out without a partial terminal claim and permits same-ID retry');

  const duplicate = synthetic('ClosureCancelled');
  const results = await Promise.all(Array.from({ length: 8 }, () => apply(duplicate)));
  assert.equal(results.filter((result) => result === 'APPLIED').length, 1);
  assert.equal(results.filter((result) => result === 'DUPLICATE').length, 7);
  assert.throws(() => apply(copied(duplicate), [owner.id]));
  assert.throws(() => apply(copied(duplicate), [], 1));
  const collision = { ...duplicate, event_type: 'FinanceClosed' };
  await assert.rejects(apply(collision), /INVALID_FINANCE_NOTIFICATION_EVENT/);
  const unblocked = synthetic('ContributionRequested', duplicate.aggregate_id, duplicate.trip_id);
  await apply(unblocked, [owner.id]);
  assert.equal((await notifications(unblocked)).length, 1);
  await publish(collision);
  await awaitDlq(collision);
  const malformed = {
    ...copied(duplicate),
    payload: { ...duplicate.payload, closure_id: 'invalid' },
  };
  await publish(malformed);
  await awaitDlq(malformed);
  assert.equal((await inbox(malformed)).length, 0);
  pass(
    'concurrent terminal duplicates are idempotent; collision/malformed contracts cannot widen a barrier and go to DLQ',
  );

  const exhausted = synthetic('FinanceClosed');
  let retained;
  await query(
    'automation',
    `CREATE FUNCTION terminal_inbox_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_id::text=TG_ARGV[0] THEN RAISE EXCEPTION 'INJECTED_TERMINAL_FAILURE'; END IF; RETURN NEW; END $$`,
  );
  try {
    await query(
      'automation',
      `CREATE TRIGGER terminal_inbox_fixture_failure BEFORE INSERT ON inbox_events
      FOR EACH ROW EXECUTE FUNCTION terminal_inbox_fixture_failure('${exhausted.event_id}')`,
    );
    await publish(exhausted, { 'x-finance-notification-attempt': 5 });
    retained = await awaitDlq(exhausted);
    assert.equal((await inbox(exhausted)).length, 0);
  } finally {
    await query(
      'automation',
      'DROP TRIGGER IF EXISTS terminal_inbox_fixture_failure ON inbox_events',
    );
    await query('automation', 'DROP FUNCTION terminal_inbox_fixture_failure()');
  }
  assert.deepEqual(retained.body, exhausted);
  await publish(retained.body);
  await processed(exhausted);
  await suppressed(synthetic('ContributionRequested', exhausted.aggregate_id, exhausted.trip_id));
  pass(
    'terminal SQL failure reaches retained DLQ without a partial barrier; unchanged same-ID replay commits after repair',
  );

  const outage = synthetic('FinanceClosed');
  await h.whileServiceStopped('finance-service', async () => {
    await h.whileServiceStopped('identity-service', async () => {
      await publish(outage);
      await processed(outage);
      assert.equal((await inbox(outage))[0].result.outcome, 'TERMINAL');
    });
  });
  pass(
    'terminal consumption succeeds during simultaneous Finance/Identity outage without disclosing any content',
  );

  const crash = synthetic('FinanceClosed');
  await crashConsumer(crash, 0);
  await suppressed(synthetic('ContributionRequested', crash.aggregate_id, crash.trip_id));
  pass(
    'actual consumer death after terminal COMMIT before ACK retains the barrier through redelivery',
  );

  const persisted = synthetic('ClosureCancelled');
  await h.whileServiceStopped('automation-service', async () => {
    await publish(persisted);
    await h.restartBroker();
    await waitFor(async () => (await (await broker()).checkQueue(queue)).messageCount >= 1, 30_000);
  });
  await processed(persisted);
  await suppressed(
    synthetic(
      'ClosureRequested',
      persisted.aggregate_id,
      persisted.trip_id,
      persisted.payload.closure_id,
    ),
  );
  pass('queued terminal event survives broker restart and prevents old closure resurrection');
}
