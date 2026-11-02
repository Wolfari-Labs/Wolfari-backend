import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runReviewInboxTests(h, s) {
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
  const mutate = async (path, body, user, method = 'POST') => {
    const key = randomUUID();
    const invoke = () => request(path, method, body, { ...bearer(user), 'Idempotency-Key': key });
    let response = await invoke();
    if (response.status === 202 && response.body?.data?.operation_id) {
      await waitFor(async () => {
        const operation = await request(
          `/api/v1/operations/${key}`,
          'GET',
          undefined,
          bearer(user),
        );
        return (
          operation.status === 200 && ['SUCCEEDED', 'FAILED'].includes(operation.body.data.state)
        );
      });
      response = await invoke();
    }
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const rows = await query(
      'finance',
      `SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
      FROM outbox_events WHERE operation_id=$1 AND event_type='ContributionUpdated'`,
      [key],
    );
    assert.equal(rows.length, 1);
    return storedEvent(rows[0]);
  };
  const contribution = async (f) =>
    (
      await query(
        'finance',
        'SELECT c.*,f.finance_version FROM contributions c JOIN funds f ON f.id=c.fund_id WHERE c.id=$1',
        [f.id],
      )
    )[0];
  const action = async (f, actionName, user = f.debtor) => {
    const row = await contribution(f);
    return mutate(
      `/api/v1/contributions/${f.id}/${actionName}`,
      {
        expected_version: row.version,
        expected_finance_version: row.finance_version,
        ...(actionName === 'reject-transfer' ? { reason: 'Isolated reconciliation fixture' } : {}),
      },
      user,
    );
  };
  const create = async (debtor = member) => {
    const f = await setupFund();
    const created = await createRequest(f, [debtor]);
    return {
      ...f,
      debtor,
      id: created.payload.contribution_ids[0],
      requestId: created.payload.request_id,
    };
  };
  const edit = async (f) => {
    const [row] = await query(
      'finance',
      'SELECT r.version,f.finance_version FROM contribution_requests r JOIN funds f ON f.id=r.fund_id WHERE r.id=$1',
      [f.requestId],
    );
    return mutate(
      `/api/v1/funds/${f.fundId}/contribution-requests/${f.requestId}`,
      {
        expected_version: row.version,
        expected_finance_version: row.finance_version,
        title: `PRIVATE metadata ${randomUUID()}`,
      },
      owner,
      'PATCH',
    );
  };
  const notices = (f) =>
    query(
      'automation',
      "SELECT * FROM notifications WHERE type='CONTRIBUTION_REVIEW' AND source_id=$1 ORDER BY created_at,id",
      [f.id],
    );
  const assertNoNotice = async (event) => {
    await processed(event);
    assert.equal((await notifications(event)).length, 0);
  };

  await query(
    'automation',
    `INSERT INTO notification_preferences(user_id,push_enabled,email_enabled) VALUES($1,false,false)
    ON CONFLICT(user_id) DO UPDATE SET push_enabled=false,email_enabled=false`,
    [holder.id],
  );
  const f = await create();
  const beforeReport = await edit(f);
  await assertNoNotice(beforeReport);
  const report = await action(f, 'report-transfer');
  await processed(report);
  const [notice] = await notices(f);
  assert(notice);
  assert.equal(notice.user_id, holder.id);
  assert.equal(notice.status, 'AVAILABLE');
  assert.equal(notice.source_id, f.id);
  assert.equal(notice.recipient_email, null);
  assert.equal((await inbox(report))[0].result.source_revision, (await contribution(f)).version);
  for (const secret of ['PRIVATE', '123456', '000987654321'])
    assert(!JSON.stringify(notice).includes(secret));
  const page = await request('/api/v1/me/notifications', 'GET', undefined, bearer(holder));
  assert.equal(page.status, 200);
  assert(JSON.stringify(page.body).includes(notice.id));
  assert.equal(
    (
      await query(
        'automation',
        'SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id=$1',
        [notice.id],
      )
    )[0].n,
    0,
  );
  pass(
    'real report-transfer -> outbox -> broker -> current Holder Self inbox with private data excluded and external preferences off',
  );

  const revision = (await contribution(f)).version;
  const metadataEvents = [];
  await h.whileServiceStopped('automation-service', async () => {
    for (let i = 0; i < 8; i++) metadataEvents.push(await edit(f));
  });
  await Promise.all(metadataEvents.map(processed));
  assert.equal((await contribution(f)).version, revision);
  assert.equal((await notices(f)).length, 1);
  for (const event of metadataEvents)
    assert.equal((await inbox(event))[0].result.duplicate_suppressed, 1);
  const immutable = await sourceFingerprint();
  await Promise.all(Array.from({ length: 12 }, () => publish(report)));
  assert.equal(
    await repository.complete(r.financeNotificationEvent(report), [holder.id], revision),
    'DUPLICATE',
  );
  assert.deepEqual(await sourceFingerprint(), immutable);
  pass(
    'eight metadata events and repeated event deliveries keep one notice per contribution revision without changing Finance',
  );

  const rejected = await action(f, 'reject-transfer', holder);
  await assertNoNotice(rejected);
  const reportedAgain = await action(f, 'report-transfer');
  await processed(reportedAgain);
  assert.equal((await notices(f)).length, 2);
  assert.equal((await inbox(reportedAgain))[0].result.source_revision, revision + 2);
  const confirmed = await action(f, 'confirm-received', holder);
  await assertNoNotice(confirmed);
  const late = copied(reportedAgain);
  await publish(late);
  await assertNoNotice(late);
  pass(
    'reject/report creates a new revision notice; confirmation and delayed report events cannot revive a settled review',
  );

  const self = await create(holder);
  const selfReport = await action(self, 'report-transfer');
  await processed(selfReport);
  assert.equal((await notices(self))[0].user_id, holder.id);
  pass('Holder self-contribution receives the same review notice without actor exclusion');

  const ordered = await create();
  const pendingMetadata = await edit(ordered);
  await assertNoNotice(pendingMetadata);
  let events;
  await h.whileServiceStopped('automation-service', async () => {
    const first = await action(ordered, 'report-transfer');
    const reject = await action(ordered, 'reject-transfer', holder);
    const second = await action(ordered, 'report-transfer');
    events = [first, reject, second, await edit(ordered)];
    // Force an old PENDING event to discover the current report, ahead of queued report events.
    const config = new r.ConfigService({ ...h.automationValues, NODE_ENV: 'test' });
    const client = new r.FinanceNotificationClient(config);
    try {
      const service = new r.FinanceNotificationService(client, repository);
      const signal = copied(reject);
      await service.process(r.financeNotificationEvent(signal));
      assert.equal((await notifications(signal)).length, 1);
      assert.equal(
        (await inbox(signal))[0].result.source_revision,
        (await contribution(ordered)).version,
      );
    } finally {
      client.onApplicationShutdown();
    }
  });
  await Promise.all(events.map(processed));
  assert.equal((await notices(ordered)).length, 1);
  pass(
    'out-of-order old-status events resolve the latest report revision and cannot create superseded report notices',
  );

  for (const mode of [
    'locked-holder',
    'departed-holder',
    'archived',
    'request-closed',
    'fund-closing',
    'fund-closed',
    'waived',
    'cancelled',
    'reversed',
  ]) {
    const target = await create();
    let event;
    await h.whileServiceStopped('automation-service', async () => {
      event = await action(target, 'report-transfer');
      if (mode === 'locked-holder')
        await query('identity', "UPDATE users SET status='LOCKED' WHERE id=$1", [holder.id]);
      else if (mode === 'departed-holder')
        await query(
          'trip',
          'UPDATE trip_members SET left_at=clock_timestamp() WHERE trip_id=$1 AND user_id=$2',
          [target.tripId, holder.id],
        );
      else if (mode === 'archived')
        await query('trip', 'UPDATE trips SET archived_at=clock_timestamp() WHERE id=$1', [
          target.tripId,
        ]);
      else if (mode === 'request-closed')
        await query('finance', "UPDATE contribution_requests SET status='CLOSED' WHERE id=$1", [
          target.requestId,
        ]);
      else if (mode.startsWith('fund-'))
        await query('finance', 'UPDATE funds SET status=$2 WHERE id=$1', [
          target.fundId,
          mode === 'fund-closing' ? 'CLOSING' : 'CLOSED',
        ]);
      else
        await query('finance', 'UPDATE contributions SET status=$2 WHERE id=$1', [
          target.id,
          mode.toUpperCase(),
        ]);
    });
    try {
      await assertNoNotice(event);
      assert.equal((await notices(target)).length, 0);
    } finally {
      if (mode === 'locked-holder')
        await query('identity', "UPDATE users SET status='ACTIVE' WHERE id=$1", [holder.id]);
    }
    pass(`delayed Holder review is suppressed for current ${mode}`);
  }

  const collision = { ...selfReport, payload: { ...selfReport.payload, status: 'PENDING' } };
  await publish(collision);
  await awaitDlq(collision);
  const malformed = {
    ...copied(selfReport),
    payload: { ...selfReport.payload, status: 'UNKNOWN' },
  };
  await publish(malformed);
  await awaitDlq(malformed);
  pass('invalid review contracts and reused event IDs with changed status go to DLQ');

  const atomic = {
    ...copied(selfReport),
    payload: { ...selfReport.payload, contribution_id: randomUUID() },
  };
  const projected = r.financeNotificationEvent(atomic);
  assert.throws(() => repository.complete(projected, [holder.id]));
  assert.throws(() => repository.complete(projected, [holder.id, owner.id], 2));
  await assert.rejects(repository.complete({ ...projected, tripId: 'invalid' }, [holder.id], 2));
  assert.equal((await inbox(atomic)).length, 0);
  const held = await pool.connect();
  try {
    await held.query('BEGIN');
    await held.query(
      `INSERT INTO notifications(user_id,trip_id,type,title,body,source_id,event_id,status,dedupe_key)
      VALUES($1,$2,'CONTRIBUTION_REVIEW','fixture','fixture',$3,$4,'AVAILABLE',$5)`,
      [
        holder.id,
        projected.tripId,
        projected.contributionId,
        atomic.event_id,
        `finance-review:${projected.contributionId}:2:${holder.id}`,
      ],
    );
    const started = Date.now();
    await assert.rejects(repository.complete(projected, [holder.id], 2));
    assert(Date.now() - started < 8000);
    assert.equal((await inbox(atomic)).length, 0);
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  await repository.complete(projected, [holder.id], 2);
  assert.equal((await notifications(atomic)).length, 1);
  pass(
    'invalid review revision, failed insert and timed-out unique-key conflict leave no partial inbox; same event retries',
  );

  const concurrentSource = randomUUID();
  const competitors = Array.from({ length: 12 }, () => ({
    ...copied(selfReport),
    payload: { ...selfReport.payload, contribution_id: concurrentSource },
  }));
  await Promise.all(
    competitors.map((event) =>
      repository.complete(r.financeNotificationEvent(event), [holder.id], 9),
    ),
  );
  assert.equal((await Promise.all(competitors.map(notifications))).flat().length, 1);
  assert.equal((await Promise.all(competitors.map(inbox))).flat().length, 12);
  assert.equal(
    (await Promise.all(competitors.map(inbox))).reduce(
      (sum, rows) => sum + rows[0].result.duplicate_suppressed,
      0,
    ),
    11,
  );
  pass(
    'twelve concurrent distinct events commit one review effect and twelve durable inbox results',
  );

  for (const dependency of ['finance-service', 'identity-service']) {
    const retry = copied(selfReport);
    await h.whileServiceStopped(dependency, async () => {
      await publish(retry);
      await waitFor(
        async () => (await (await broker()).checkQueue(`${queue}.retry.0`)).messageCount > 0,
      );
      assert.equal((await inbox(retry)).length, 0);
    });
    await processed(retry);
    assert.equal((await notices(self)).length, 1);
    pass(
      `Holder review ${dependency} outage retries without partial state or repeated revision notice`,
    );
  }
  const exhausted = copied(selfReport);
  let retained;
  await h.whileServiceStopped('finance-service', async () => {
    await publish(exhausted, { 'x-finance-notification-attempt': 5 });
    retained = await awaitDlq(exhausted);
    assert.equal((await inbox(exhausted)).length, 0);
  });
  assert.deepEqual(retained.body, exhausted);
  await publish(retained.body);
  await processed(exhausted);
  assert.equal((await notices(self)).length, 1);
  pass(
    'Holder DLQ replay keeps the event identity and does not repeat a previously notified revision',
  );

  // Advance only isolated fixture versions so the crash child is the first creator for this revision.
  await query('finance', 'UPDATE contributions SET version=version+1 WHERE id=$1', [self.id]);
  const crash = copied(selfReport);
  await crashConsumer(crash, 1);
  assert.equal((await notices(self)).length, 2);
  pass(
    'actual process death after review commit before ACK preserves one notification for its revision',
  );
  await query('finance', 'UPDATE contributions SET version=version+1 WHERE id=$1', [self.id]);
  const persisted = copied(selfReport);
  await h.whileServiceStopped('automation-service', async () => {
    await publish(persisted);
    await h.restartBroker();
    await waitFor(async () => (await (await broker()).checkQueue(queue)).messageCount >= 1, 30_000);
  });
  await processed(persisted);
  assert.equal((await notifications(persisted)).length, 1);
  pass('Holder review survives broker restart and revalidates the current contribution revision');
}
