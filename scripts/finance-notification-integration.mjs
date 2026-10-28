import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import amqp from 'amqplib';
import pg from 'pg';
import { appEnvironment, apps } from './config.mjs';
import { runClosureInboxTests } from './finance-closure-inbox-integration.mjs';

const require = createRequire(import.meta.url);
const appRequire = createRequire(
  new URL('../apps/automation-service/package.json', import.meta.url),
);
const queue = 'wolfari.automation.finance-notifications.v1';
const consumerName = 'AutomationFinanceContributionInbox';
const attemptHeader = 'x-finance-notification-attempt';
function runtime() {
  return {
    ...require('../apps/automation-service/dist/finance-notification/finance-notification.event.js'),
    ...require('../apps/automation-service/dist/finance-notification/finance-notification.client.js'),
    ...require('../apps/automation-service/dist/finance-notification/finance-notification.repository.js'),
    ...require('../apps/automation-service/dist/finance-notification/finance-notification.service.js'),
    ...require('../apps/automation-service/dist/finance-notification/finance-notification.consumer.js'),
    ConfigService: appRequire('@nestjs/config').ConfigService,
  };
}

export async function runFinanceNotificationTests(h) {
  const { query, request, bearer, account, tripBody, pass, waitFor } = h;
  const owner = await account('Inbox owner'),
    holder = await account('Inbox holder'),
    member = await account('Inbox debtor');
  const write = (path, body, user = owner) =>
    request(path, 'POST', body, { ...bearer(user), 'Idempotency-Key': randomUUID() });
  let connection, channel;
  const broker = async () => {
    if (channel) return channel;
    connection = await amqp.connect(h.brokerUrl, { timeout: 3000 });
    connection.on('error', () => {
      channel = undefined;
    });
    connection.on('close', () => {
      channel = undefined;
    });
    channel = await connection.createConfirmChannel();
    channel.on('error', () => {
      channel = undefined;
    });
    channel.on('close', () => {
      channel = undefined;
    });
    return channel;
  };
  const publish = async (event, headers = {}, target = queue) => {
    const c = await broker();
    await new Promise((resolve, reject) =>
      c.sendToQueue(
        target,
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          mandatory: true,
          messageId: event.event_id,
          contentType: 'application/json',
          headers,
        },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  };
  const inbox = (event) =>
    query('automation', 'SELECT * FROM inbox_events WHERE consumer_name=$1 AND event_id=$2', [
      consumerName,
      event.event_id,
    ]);
  const notifications = (event) =>
    query('automation', 'SELECT * FROM notifications WHERE event_id=$1 ORDER BY user_id', [
      event.event_id,
    ]);
  const processed = (event) => waitFor(async () => (await inbox(event)).length === 1, 30_000);
  const copied = (event) => ({ ...event, event_id: randomUUID() });
  const awaitDlq = async (event) => {
    let result;
    await waitFor(async () => {
      const value = await (await broker()).get(`${queue}.dlq`, { noAck: false });
      if (!value) return false;
      const body = JSON.parse(value.content.toString());
      assert.equal(body.event_id, event.event_id);
      result = { body, headers: value.properties.headers };
      (await broker()).ack(value);
      return true;
    }, 20_000);
    return result;
  };
  const setupFund = async (people = [owner, holder, member]) => {
    const trip = await request(
      '/api/v1/trips',
      'POST',
      tripBody('PRIVATE inbox trip'),
      bearer(owner),
    );
    assert.equal(trip.status, 201);
    const tripId = trip.body.data.id;
    for (const user of people.filter((user) => user.id !== owner.id))
      await query(
        'trip',
        "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',clock_timestamp()-interval '2 days')",
        [tripId, user.id],
      );
    await query(
      'trip',
      "UPDATE trip_members SET joined_at=clock_timestamp()-interval '2 days' WHERE trip_id=$1",
      [tripId],
    );
    const enabled = await write(`/api/v1/trips/${tripId}/fund`, {
      holder_user_id: holder.id,
      currency: 'VND',
      destination: {
        destination_type: 'VIETQR',
        bank_code: 'TEST',
        account_number: '000987654321',
        account_name: 'PRIVATE account',
        is_default: true,
        active: true,
      },
    });
    assert.equal(enabled.status, 201);
    const fundId = enabled.body.data.id;
    const [destination] = await query(
      'finance',
      'SELECT id FROM payment_destinations WHERE fund_id=$1',
      [fundId],
    );
    const confirmed = await write(
      `/api/v1/funds/${fundId}/destinations/${destination.id}/confirm`,
      { expected_version: 1, expected_finance_version: 1 },
      holder,
    );
    assert.equal(confirmed.status, 200);
    return { tripId, fundId, destinationId: destination.id };
  };
  const createRequest = async (fund, people = [owner, member]) => {
    const [row] = await query('finance', 'SELECT finance_version FROM funds WHERE id=$1', [
      fund.fundId,
    ]);
    const response = await write(`/api/v1/funds/${fund.fundId}/contribution-requests`, {
      title: 'PRIVATE request title',
      note: 'PRIVATE request note',
      expected_finance_version: row.finance_version,
      contributions: people.map((user) => ({
        member_user_id: user.id,
        amount: '123456',
        destination_id: fund.destinationId,
      })),
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const [stored] = await query(
      'finance',
      `SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
      FROM outbox_events WHERE aggregate_id=$1 AND event_type='ContributionRequested' ORDER BY aggregate_version DESC LIMIT 1`,
      [fund.fundId],
    );
    const {
      storedFinanceEvent,
    } = require('../apps/finance-service/dist/outbox/finance-outbox.event.js');
    return storedFinanceEvent(stored);
  };
  const sourceFingerprint = async () => {
    const result = {};
    for (const [service, tables] of Object.entries({
      finance: [
        'funds',
        'contributions',
        'contribution_requests',
        'fund_transactions',
        'finance_audit_logs',
        'finance_closures',
        'closure_confirmations',
      ],
      identity: ['users', 'credentials', 'refresh_sessions'],
      trip: ['trips', 'trip_members'],
    })) {
      result[service] = await query(
        service,
        tables
          .map(
            (table) =>
              `SELECT '${table}' AS name,md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS hash FROM ${table} t`,
          )
          .join(' UNION ALL ') + ' ORDER BY name',
      );
    }
    return result;
  };
  const r = runtime();
  const pool = new pg.Pool({
    connectionString: h.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  pool.on('error', () => {});
  const repository = new r.FinanceNotificationRepository({ pool });
  try {
    await waitFor(async () => (await (await broker()).checkQueue(queue)).consumerCount > 0);
    const base = await setupFund();
    await query(
      'automation',
      'INSERT INTO notification_preferences(user_id,push_enabled,email_enabled) VALUES($1,false,false)',
      [owner.id],
    );
    const original = await createRequest(base);
    await processed(original);
    const rows = await notifications(original);
    assert.deepEqual(rows.map((row) => row.user_id).sort(), [owner.id, member.id].sort());
    for (const row of rows) {
      assert.equal(row.status, 'AVAILABLE');
      assert.equal(row.source_id, original.payload.request_id);
      assert.equal(row.recipient_email, null);
      assert.equal(row.type, 'CONTRIBUTION_REQUESTED');
      for (const privateValue of ['PRIVATE', '123456', '000987654321'])
        assert(!JSON.stringify(row).includes(privateValue));
    }
    const page = await request('/api/v1/me/notifications', 'GET', undefined, bearer(owner));
    assert.equal(page.status, 200);
    assert(JSON.stringify(page.body).includes(rows.find((row) => row.user_id === owner.id).id));
    assert.equal(
      (
        await query(
          'automation',
          `SELECT count(*)::int AS n FROM notification_deliveries d
      JOIN notifications n ON n.id=d.notification_id WHERE n.event_id=$1`,
          [original.event_id],
        )
      )[0].n,
      0,
    );
    pass(
      'real API078 -> committed Finance outbox -> RabbitMQ -> current Finance/Identity -> Self inbox, including actor and disabled external preferences',
    );

    const unchanged = await sourceFingerprint();
    await Promise.all(Array.from({ length: 20 }, () => publish(original)));
    await h.whileServiceStopped('automation-service', async () => {
      await publish(original);
    });
    await waitFor(async () => (await (await broker()).checkQueue(queue)).messageCount === 0);
    assert.equal((await notifications(original)).length, 2);
    assert.deepEqual(await sourceFingerprint(), unchanged);
    pass(
      'concurrent duplicate deliveries and Automation restart preserve one inbox/event and notifications, with no source-service writes',
    );

    let inactive;
    await h.whileServiceStopped('automation-service', async () => {
      inactive = await createRequest(base, [owner, holder, member]);
      await query('identity', "UPDATE users SET status='LOCKED' WHERE id=$1", [member.id]);
      await query(
        'trip',
        'UPDATE trip_members SET left_at=clock_timestamp() WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL',
        [base.tripId, holder.id],
      );
    });
    await processed(inactive);
    assert.deepEqual(
      (await notifications(inactive)).map((row) => row.user_id),
      [owner.id],
    );
    await query('identity', "UPDATE users SET status='ACTIVE' WHERE id=$1", [member.id]);
    pass(
      'current locked account and departed membership are suppressed while the eligible owner receives the same event',
    );

    for (const mode of [
      'request-closed',
      'waived',
      'fund-closed',
      'archived',
      'rejoined',
      'deletion-pending',
    ]) {
      let event;
      await h.whileServiceStopped('automation-service', async () => {
        const fund = await setupFund();
        event = await createRequest(fund, [member]);
        if (mode === 'request-closed')
          await query('finance', "UPDATE contribution_requests SET status='CLOSED' WHERE id=$1", [
            event.payload.request_id,
          ]);
        if (mode === 'waived')
          await query('finance', "UPDATE contributions SET status='WAIVED' WHERE request_id=$1", [
            event.payload.request_id,
          ]);
        if (mode === 'fund-closed')
          await query('finance', "UPDATE funds SET status='CLOSED' WHERE id=$1", [fund.fundId]);
        if (mode === 'archived')
          await query('trip', 'UPDATE trips SET archived_at=clock_timestamp() WHERE id=$1', [
            fund.tripId,
          ]);
        if (mode === 'rejoined') {
          await query(
            'trip',
            'UPDATE trip_members SET left_at=clock_timestamp() WHERE trip_id=$1 AND user_id=$2',
            [fund.tripId, member.id],
          );
          await query(
            'trip',
            "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',clock_timestamp())",
            [fund.tripId, member.id],
          );
        }
        if (mode === 'deletion-pending')
          await query(
            'identity',
            "UPDATE users SET status='DELETION_PENDING',deletion_requested_at=clock_timestamp() WHERE id=$1",
            [member.id],
          );
      });
      await processed(event);
      assert.equal((await notifications(event)).length, 0);
      assert.equal((await inbox(event))[0].result.outcome, 'SUPPRESSED');
      if (mode === 'deletion-pending')
        await query(
          'identity',
          "UPDATE users SET status='ACTIVE',deletion_requested_at=NULL WHERE id=$1",
          [member.id],
        );
      pass(`delayed event is durably suppressed for ${mode} based on current source/account state`);
    }

    let lateJoin;
    await h.whileServiceStopped('automation-service', async () => {
      const fund = await setupFund([owner, holder]);
      lateJoin = await createRequest(fund, [owner]);
      await query(
        'trip',
        "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',clock_timestamp())",
        [fund.tripId, member.id],
      );
    });
    await processed(lateJoin);
    assert.deepEqual(
      (await notifications(lateJoin)).map((row) => row.user_id),
      [owner.id],
    );
    pass('a later member receives no old obligation or contribution notification');

    const extra = Array.from({ length: 101 }, () => ({ id: randomUUID() }));
    await query(
      'identity',
      "INSERT INTO users(id,email,full_name) SELECT id,id::text || '@inbox.test','Batch recipient' FROM unnest($1::uuid[]) id",
      [extra.map((user) => user.id)],
    );
    const batchFund = await setupFund([owner, holder, ...extra]);
    const batch = await createRequest(batchFund, extra);
    await processed(batch);
    assert.equal((await notifications(batch)).length, 101);
    pass(
      'real gRPC processes more than 100 current recipients across bounded Identity batches without partial notifications',
    );

    const atomic = copied(original),
      parsed = r.contributionNotificationEvent(atomic);
    await assert.rejects(repository.complete({ ...parsed, tripId: 'not-a-uuid' }, [owner.id]));
    assert.equal((await inbox(atomic)).length, 0);
    assert.equal((await notifications(atomic)).length, 0);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => repository.complete(parsed, [owner.id])),
    );
    assert.equal(outcomes.filter((value) => value === 'APPLIED').length, 1);
    assert.equal((await notifications(atomic)).length, 1);
    pass(
      'real PostgreSQL rolls back inbox with failed notification insert and serializes eight competing same-event commits',
    );

    const collision = { ...original, payload: { ...original.payload, request_id: randomUUID() } };
    await publish(collision);
    await awaitDlq(collision);
    assert.equal((await notifications(original)).length, 2);
    for (const change of [{ producer: 'Trip' }, { schema_version: 9 }, { trip_id: randomUUID() }]) {
      const bad = { ...copied(original), ...change };
      await publish(bad);
      await awaitDlq(bad);
      assert.equal((await inbox(bad)).length, 0);
    }
    pass(
      'foreign/unknown/inconsistent contracts and reused event IDs with changed identity go to DLQ without business writes',
    );

    for (const service of ['finance-service', 'identity-service']) {
      const retry = copied(original);
      await h.whileServiceStopped(service, async () => {
        await publish(retry);
        await waitFor(
          async () => (await (await broker()).checkQueue(`${queue}.retry.0`)).messageCount > 0,
        );
        assert.equal((await inbox(retry)).length, 0);
      });
      await processed(retry);
      assert.equal((await notifications(retry)).length, 2);
      pass(
        `${service} outage leaves no partial inbox; durable 10-second retry recovers after restart`,
      );
    }

    const exhausted = copied(original);
    let retained;
    await h.whileServiceStopped('finance-service', async () => {
      await publish(exhausted, { [attemptHeader]: 5 });
      retained = await awaitDlq(exhausted);
      assert.equal((await inbox(exhausted)).length, 0);
      assert.equal(retained.headers['x-finance-notification-result'], 'RETRIES_EXHAUSTED');
    });
    assert.deepEqual(retained.body, exhausted);
    await publish(retained.body);
    await processed(exhausted);
    await publish(retained.body);
    assert.equal((await notifications(exhausted)).length, 2);
    pass(
      'exhausted consumer work stays in DLQ and explicit same-ID replay recovers exactly one set of notifications',
    );

    const crashConsumer = async (crashEvent, expected) => {
      await h.whileServiceStopped('automation-service', async () => {
        const child = fork(
          fileURLToPath(import.meta.url),
          ['--finance-notification-crash-worker'],
          {
            env: appEnvironment(
              apps.find((app) => app.name === 'automation-service'),
              { NODE_ENV: 'test', ...h.automationValues },
            ),
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            windowsHide: true,
          },
        );
        let committed = false;
        child.on('message', (value) => {
          if (value === 'COMMITTED_BEFORE_ACK') committed = true;
        });
        try {
          await waitFor(async () => (await (await broker()).checkQueue(queue)).consumerCount > 0);
          await publish(crashEvent);
          await waitFor(() => child.exitCode !== null || child.signalCode !== null);
          assert(committed, 'crash child must have committed before terminating');
          assert.equal((await notifications(crashEvent)).length, expected);
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
      });
      await waitFor(async () => (await (await broker()).checkQueue(queue)).messageCount === 0);
      assert.equal((await notifications(crashEvent)).length, expected);
    };
    await crashConsumer(copied(original), 2);
    pass(
      'actual consumer process death after DB commit before ACK redelivers without duplicating in-app notifications',
    );

    const restart = copied(original);
    await h.whileServiceStopped('automation-service', async () => {
      await publish(restart);
      await h.restartBroker();
      await waitFor(
        async () => (await (await broker()).checkQueue(queue)).messageCount >= 1,
        30_000,
      );
    });
    await processed(restart);
    assert.equal((await notifications(restart)).length, 2);
    pass(
      'confirmed queued notification survives broker restart and resumes with original event identity',
    );
    await runClosureInboxTests(h, {
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
      storedEvent: require('../apps/finance-service/dist/outbox/finance-outbox.event.js')
        .storedFinanceEvent,
    });
  } finally {
    await channel?.close().catch(() => {});
    await connection?.close().catch(() => {});
    await pool.end();
  }
}

if (process.argv.includes('--finance-notification-crash-worker')) {
  const r = runtime();
  const config = new r.ConfigService(process.env);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  pool.on('error', () => {});
  const client = new r.FinanceNotificationClient(config);
  const service = new r.FinanceNotificationService(
    client,
    new r.FinanceNotificationRepository({ pool }),
  );
  const worker = new r.FinanceNotificationConsumer(config, {
    process: async (event, signal) => {
      await service.process(event, signal);
      await new Promise((resolve) => process.send('COMMITTED_BEFORE_ACK', resolve));
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    },
  });
  worker.onApplicationBootstrap();
}
