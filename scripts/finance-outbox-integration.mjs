import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import amqp from 'amqplib';
import pg from 'pg';
import { root, databaseUrl } from './config.mjs';
import { compose } from './infrastructure.mjs';
import { migrate, migrationFiles } from './migrations.mjs';
import { createTestPortAllocator } from './test-ports.mjs';
import { startTestService } from './test-container.mjs';

const require = createRequire(import.meta.url);
const {
  FinanceOutboxRepository,
} = require('../apps/finance-service/dist/outbox/finance-outbox.repository.js');
const {
  FinanceOutboxService,
} = require('../apps/finance-service/dist/outbox/finance-outbox.service.js');
const {
  FinanceOutboxPublisher,
} = require('../apps/finance-service/dist/outbox/finance-outbox.publisher.js');
const {
  storedFinanceEvent,
} = require('../apps/finance-service/dist/outbox/finance-outbox.event.js');
const { parseEventForPublish, EVENT_TOPOLOGY } = require('../packages/contracts/dist/events.js');
const executeFile = promisify(execFile);
const eventTypes = [
  'ContributionRequested',
  'ContributionUpdated',
  'ClosureRequested',
  'ClosureCancelled',
  'FinanceClosed',
];
const businessTables = [
  'funds',
  'payment_destinations',
  'contribution_requests',
  'contributions',
  'payment_attempts',
  'payment_webhook_receipts',
  'fund_expenses',
  'financial_notes',
  'fund_refunds',
  'fund_transactions',
  'finance_closures',
  'closure_confirmations',
  'command_receipts',
  'payment_provider_configs',
  'finance_audit_logs',
  'finance_files',
];
const envelopeFields = [
  'event_id',
  'event_type',
  'schema_version',
  'occurred_at',
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
];
const privateMarker = 'synthetic-private-account-000123456';

async function bounded(work, label, milliseconds = 12000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`FINANCE_OUTBOX_TIMEOUT_${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor(work, label, milliseconds = 20000) {
  const until = Date.now() + milliseconds;
  let last;
  while (Date.now() < until) {
    try {
      const value = await work();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`FINANCE_OUTBOX_WAIT_${label}`, { cause: last });
}
function database(pool) {
  return { pool };
}
function configuration(url) {
  return {
    get: (key) => ({ NODE_ENV: 'test', FINANCE_OUTBOX_ENABLED: 'false', RABBITMQ_URL: url })[key],
  };
}
function immutable(row) {
  return Object.fromEntries(
    envelopeFields.map((key) => [
      key,
      key === 'occurred_at' && row[key] instanceof Date ? row[key].toISOString() : row[key],
    ]),
  );
}

// Child-only crash barrier: the actual publisher has confirmed before complete is called.
async function crashWorker() {
  if (
    !process.send ||
    process.env.NODE_ENV !== 'test' ||
    !/^wolfari-test-[a-f0-9]{12}$/.test(process.env.WOLFARI_OUTBOX_PROJECT ?? '')
  )
    throw new Error('ISOLATED_CHILD_ONLY');
  const target = new URL(process.env.WOLFARI_OUTBOX_DATABASE_URL);
  if (
    target.hostname !== '127.0.0.1' ||
    target.pathname !== '/finance_db' ||
    decodeURIComponent(target.username) !== 'finance_app'
  )
    throw new Error('ISOLATED_FINANCE_ONLY');
  const pool = new pg.Pool({
    connectionString: target.href,
    max: 2,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  const repo = new FinanceOutboxRepository(database(pool));
  const config = configuration(process.env.WOLFARI_OUTBOX_BROKER_URL);
  const publisher = new FinanceOutboxPublisher(config);
  const complete = repo.complete.bind(repo);
  repo.complete = async (claim) => {
    if (claim.event_id !== process.env.WOLFARI_OUTBOX_CRASH_EVENT) return complete(claim);
    process.send({ type: 'confirmed-before-mark', eventId: claim.event_id });
    await bounded(new Promise(() => {}), 'CRASH_BARRIER');
    return false;
  };
  const service = new FinanceOutboxService(repo, publisher, config);
  try {
    await service.runOnce();
  } finally {
    await service.onApplicationShutdown();
    await pool.end();
  }
}

async function main() {
  const project = `wolfari-test-${randomBytes(6).toString('hex')}`;
  const port = createTestPortAllocator();
  const queueName = `wolfari.test.finance-outbox.${randomBytes(8).toString('hex')}`;
  const services = [];
  let directory, env, pool, captureConnection, capture, child;
  let created = false,
    checks = 0,
    stage = 'setup';
  const pass = (message) => {
    checks++;
    console.log(`PASS ${message}`);
  };
  const docker = (args) => compose(env, args, { project, envFile: resolve(directory, '.env') });
  let brokerUrl;
  const closeCapture = async () => {
    await capture?.close().catch(() => {});
    await captureConnection?.close().catch(() => {});
    capture = undefined;
    captureConnection = undefined;
  };
  const openCapture = async () => {
    const connection = await amqp.connect(brokerUrl, { timeout: 3000 });
    connection.on('error', () => {});
    try {
      const channel = await connection.createChannel();
      channel.on('error', () => {});
      await channel.assertExchange(EVENT_TOPOLOGY.exchange.name, 'topic', { durable: true });
      await channel.assertQueue(queueName, { durable: true, autoDelete: false });
      for (const type of eventTypes)
        await channel.bindQueue(queueName, EVENT_TOPOLOGY.exchange.name, type);
      captureConnection = connection;
      capture = channel;
      return true;
    } catch (error) {
      await connection.close().catch(() => {});
      throw error;
    }
  };
  try {
    await mkdir(resolve(root, '.cache'), { recursive: true });
    directory = await mkdtemp(resolve(root, '.cache', 'finance-outbox-test-'));
    env = parseEnv(
      (await readFile(resolve(root, '.env.example'), 'utf8')).replace(/change-me-[\w-]+/g, () =>
        randomBytes(24).toString('hex'),
      ),
    );
    for (const key of [
      'POSTGRES_PORT',
      'RABBITMQ_PORT',
      'RABBITMQ_MANAGEMENT_PORT',
      'MINIO_API_PORT',
      'MINIO_CONSOLE_PORT',
      'MAILPIT_SMTP_PORT',
      'MAILPIT_UI_PORT',
    ])
      env[key] = String(await port());
    await writeFile(
      resolve(directory, '.env'),
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      { mode: 0o600 },
    );
    created = true;
    stage = 'infrastructure';
    await docker(['up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'rabbitmq']);
    const connectionString = databaseUrl(env, 'finance');
    await migrate('finance', connectionString, await migrationFiles('finance'));
    pool = new pg.Pool({
      connectionString,
      max: 6,
      connectionTimeoutMillis: 2000,
      statement_timeout: 5000,
    });
    pool.on('error', () => {});
    const db = database(pool);
    const url = new URL(`amqp://127.0.0.1:${env.RABBITMQ_PORT}`);
    url.username = env.RABBITMQ_DEFAULT_USER;
    url.password = env.RABBITMQ_DEFAULT_PASS;
    brokerUrl = url.href;
    await openCapture();
    const config = configuration(brokerUrl);
    const repo = new FinanceOutboxRepository(db);
    const publisher = new FinanceOutboxPublisher(config);
    const service = new FinanceOutboxService(repo, publisher, config);
    services.push(service);
    const tripId = randomUUID(),
      userId = randomUUID(),
      fundId = randomUUID();
    await pool.query(
      'INSERT INTO funds(id,trip_id,holder_user_id,current_balance,finance_version) VALUES($1,$2,$3,123400,7)',
      [fundId, tripId, userId],
    );
    const businessSnapshot = async () =>
      (
        await pool.query(
          businessTables
            .map(
              (table) =>
                `SELECT '${table}' AS name,count(*)::text AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS fingerprint FROM ${table} t`,
            )
            .join(' UNION ALL ') + ' ORDER BY name',
        )
      ).rows;
    const beforeBusiness = await businessSnapshot();
    const originals = new Map();
    const makeEvent = (type, overrides = {}) => {
      const payload = { fund_id: fundId, trip_id: tripId, finance_version: 7 };
      if (type === 'ContributionRequested')
        Object.assign(payload, { request_id: randomUUID(), contribution_ids: [randomUUID()] });
      else if (type === 'ContributionUpdated')
        Object.assign(payload, { contribution_id: randomUUID(), status: 'PENDING' });
      else
        Object.assign(payload, {
          closure_id: randomUUID(),
          ...(type === 'ClosureRequested' ? { snapshot_hash: 'a'.repeat(64) } : {}),
        });
      return {
        event_id: randomUUID(),
        event_type: type,
        schema_version: 1,
        occurred_at: '2026-10-25T12:34:56.123456Z',
        producer: 'Finance',
        aggregate_type: 'Fund',
        aggregate_id: fundId,
        aggregate_version: 7,
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: randomUUID(),
        trip_id: tripId,
        actor_user_id: userId,
        system_actor: null,
        payload,
        ...overrides,
      };
    };
    const insert = async (event, eventStatus = 'PENDING', attempts = 0) => {
      await pool.query(
        `INSERT INTO outbox_events(${envelopeFields.join(',')},status,attempt_count,next_attempt_at)
        VALUES(${envelopeFields.map((_, index) => `$${index + 1}`).join(',')},$16,$17,clock_timestamp()-interval '1 second')`,
        [
          ...envelopeFields.map((key) =>
            key === 'payload' ? JSON.stringify(event[key]) : event[key],
          ),
          eventStatus,
          attempts,
        ],
      );
      originals.set(event.event_id, structuredClone(event));
      return event;
    };
    const state = async (id) =>
      (
        await pool.query(
          `SELECT *,to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at FROM outbox_events WHERE event_id=$1`,
          [id],
        )
      ).rows[0];
    const due = (id) =>
      pool.query(
        "UPDATE outbox_events SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
        [id],
      );
    const expire = (id) =>
      pool.query(
        "UPDATE outbox_events SET claim_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
        [id],
      );
    const messages = async () => {
      const found = [];
      for (let index = 0; index < 100; index++) {
        const message = await capture.get(queueName, { noAck: true });
        if (!message) return found;
        const event = JSON.parse(message.content.toString());
        assert.equal(event.occurred_at, '2026-10-25T12:34:56.123456Z');
        assert.equal(message.properties.messageId, event.event_id);
        assert.equal(message.fields.routingKey, event.event_type);
        assert.equal(message.properties.deliveryMode, 2);
        assert.equal(message.properties.contentType, 'application/json');
        assert.equal(message.properties.contentEncoding, 'utf-8');
        found.push({ event, bytes: message.content.toString() });
      }
      throw new Error('CAPTURE_QUEUE_NOT_BOUNDED');
    };
    const verifyPublished = async (events) => {
      const found = await messages();
      assert.deepEqual(
        found.map((item) => item.event.event_id).sort(),
        events.map((event) => event.event_id).sort(),
      );
      for (const event of events) {
        assert.deepEqual(found.find((item) => item.event.event_id === event.event_id).event, event);
        assert.equal((await state(event.event_id)).status, 'PUBLISHED');
      }
      return found;
    };

    stage = 'five-finance-events';
    const initial = [];
    for (const type of eventTypes)
      initial.push(await insert(parseEventForPublish(makeEvent(type))));
    initial.push(await insert(parseEventForPublish(makeEvent('ContributionUpdated'))));
    initial.push(await insert({ ...initial[2], event_id: randomUUID() }));
    await bounded(service.runOnce(), 'FIVE_EVENTS');
    await verifyPublished(initial);
    pass(
      'five Finance event types publish confirmed persistent messages; same-version siblings and reminders keep their identities',
    );

    stage = 'concurrent-workers';
    const secondRepo = new FinanceOutboxRepository(db);
    const secondPublisher = new FinanceOutboxPublisher(config);
    const secondService = new FinanceOutboxService(secondRepo, secondPublisher, config);
    services.push(secondService);
    const concurrent = [];
    for (let index = 0; index < 12; index++)
      concurrent.push(await insert(makeEvent('ContributionUpdated')));
    await bounded(Promise.all([service.runOnce(), secondService.runOnce()]), 'TWO_WORKERS');
    await verifyPublished(concurrent);
    pass('two real workers claim independent rows without duplicate concurrent publication');

    stage = 'lease-fencing';
    const fenced = await insert(makeEvent('ContributionUpdated'), 'PENDING', 2147483647);
    const oldClaim = await repo.claimNext();
    assert.equal(oldClaim.event_id, fenced.event_id);
    assert.equal(await secondRepo.claimNext(), undefined);
    await expire(fenced.event_id);
    const newClaim = await secondRepo.claimNext();
    assert.equal(newClaim.event_id, fenced.event_id);
    assert.notEqual(newClaim.claim_owner, oldClaim.claim_owner);
    assert.equal(newClaim.attempt_count, 2147483647);
    assert.equal(await repo.complete(oldClaim), false);
    assert.equal(await repo.fail(oldClaim, 'PUBLISH_FAILED'), false);
    await publisher.publish(storedFinanceEvent(newClaim));
    assert.equal(await secondRepo.complete(newClaim), true);
    await verifyPublished([fenced]);
    pass('lease tokens fence stale completions and failures even when attempt_count saturates');

    stage = 'mandatory-return';
    await capture.unbindQueue(queueName, EVENT_TOPOLOGY.exchange.name, 'ClosureCancelled');
    const unroutable = await insert(makeEvent('ClosureCancelled'), 'PENDING', 5);
    await bounded(service.runOnce(), 'UNROUTABLE');
    let retry = await state(unroutable.event_id);
    assert.equal(retry.status, 'PENDING');
    assert.equal(retry.published_at, null);
    assert.equal(retry.attempt_count, 6);
    assert.equal(retry.last_error, 'PUBLISH_FAILED');
    assert.equal(
      (
        await pool.query(
          "SELECT next_attempt_at>clock_timestamp()+interval '14 minutes' AS capped FROM outbox_events WHERE event_id=$1",
          [unroutable.event_id],
        )
      ).rows[0].capped,
      true,
    );
    await due(unroutable.event_id);
    await bounded(service.runOnce(), 'CAPPED_RETRY');
    retry = await state(unroutable.event_id);
    assert.equal(retry.status, 'PENDING');
    assert.equal(retry.attempt_count, 7);
    assert.equal(
      (
        await pool.query(
          "SELECT next_attempt_at>clock_timestamp()+interval '14 minutes' AS capped FROM outbox_events WHERE event_id=$1",
          [unroutable.event_id],
        )
      ).rows[0].capped,
      true,
    );
    assert.deepEqual(await messages(), []);
    await capture.bindQueue(queueName, EVENT_TOPOLOGY.exchange.name, 'ClosureCancelled');
    await due(unroutable.event_id);
    await service.runOnce();
    await verifyPublished([unroutable]);
    pass(
      'real mandatory returns override confirm ACK; transient retries remain pending beyond five attempts with capped delay',
    );

    stage = 'confirmed-before-database-mark';
    const ambiguous = await insert(makeEvent('ContributionRequested'));
    const trigger = `outbox_mark_${randomBytes(5).toString('hex')}`;
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_id='${ambiguous.event_id}'::uuid AND NEW.status='PUBLISHED'
      THEN RAISE EXCEPTION 'SYNTHETIC_OUTBOX_MARK_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${trigger} BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    let firstDelivery;
    try {
      await assert.rejects(bounded(service.runOnce(), 'DATABASE_MARK_FAILURE'));
      [firstDelivery] = await messages();
      assert.deepEqual(firstDelivery.event, ambiguous);
      const pending = await state(ambiguous.event_id);
      assert.equal(pending.status, 'PENDING');
      assert.equal(pending.published_at, null);
      assert(pending.claim_owner);
    } finally {
      await pool.query(`DROP TRIGGER ${trigger} ON outbox_events; DROP FUNCTION ${trigger}()`);
    }
    await expire(ambiguous.event_id);
    await service.runOnce();
    const [secondDelivery] = await verifyPublished([ambiguous]);
    assert.equal(secondDelivery.bytes, firstDelivery.bytes);
    pass(
      'confirmed publication followed by real SQL failure redelivers the same event without losing the durable row',
    );

    stage = 'crash-before-database-mark';
    const crashed = await insert(makeEvent('ContributionUpdated'));
    child = fork(resolve(root, 'scripts/finance-outbox-integration.mjs'), ['--crash-worker'], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WOLFARI_OUTBOX_PROJECT: project,
        WOLFARI_OUTBOX_DATABASE_URL: connectionString,
        WOLFARI_OUTBOX_BROKER_URL: brokerUrl,
        WOLFARI_OUTBOX_CRASH_EVENT: crashed.event_id,
      },
    });
    await bounded(
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('CRASH_CHILD_EXITED_BEFORE_BARRIER')));
        child.on('message', (message) => {
          if (message?.type === 'confirmed-before-mark' && message.eventId === crashed.event_id)
            resolve();
        });
      }),
      'CRASH_CHILD_READY',
    );
    const [beforeCrash] = await messages();
    assert.deepEqual(beforeCrash.event, crashed);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await bounded(exited, 'CRASH_CHILD_EXIT');
    child = undefined;
    assert.equal((await state(crashed.event_id)).status, 'PENDING');
    await expire(crashed.event_id);
    await service.runOnce();
    const [afterCrash] = await verifyPublished([crashed]);
    assert.equal(afterCrash.bytes, beforeCrash.bytes);
    pass(
      'actual publisher process death after confirmation preserves same-ID redelivery after lease recovery',
    );

    stage = 'poison-payload';
    const invalid = [
      makeEvent('ContributionRequested', {
        payload: { ...makeEvent('ContributionRequested').payload, account_number: privateMarker },
      }),
      makeEvent('ContributionUpdated', { schema_version: 99 }),
      makeEvent('ContributionUpdated', { event_type: 'UnknownFinanceEvent' }),
      parseEventForPublish(
        makeEvent('TripArchived', {
          producer: 'Trip',
          aggregate_type: 'Trip',
          aggregate_id: tripId,
          payload: { trip_id: tripId, export_revision: 7 },
        }),
      ),
    ];
    await capture.bindQueue(queueName, EVENT_TOPOLOGY.exchange.name, 'UnknownFinanceEvent');
    await capture.bindQueue(queueName, EVENT_TOPOLOGY.exchange.name, 'TripArchived');
    for (const event of invalid) await insert(event);
    const healthy = await insert(makeEvent('ContributionUpdated'));
    await service.runOnce();
    await verifyPublished([healthy]);
    for (const event of invalid) {
      const row = await state(event.event_id);
      assert.equal(row.status, 'FAILED');
      assert.equal(row.last_error, 'INVALID_EVENT');
      assert.deepEqual(immutable(row), event);
      await assert.rejects(repo.replayFailed(event.event_id, 'poison-unrepaired'));
    }
    pass(
      'unknown, foreign and private payloads never reach RabbitMQ; poison remains durable and does not block healthy rows',
    );

    stage = 'operator-replay';
    const replayEnv = resolve(directory, 'replay.env');
    await writeFile(replayEnv, `NODE_ENV=test\nDATABASE_URL=${connectionString}\n`, {
      mode: 0o600,
    });
    const cli = async (id, reason, expectedExit = 0, envFile = replayEnv) => {
      let result;
      try {
        result = await executeFile(
          process.execPath,
          [
            resolve(root, 'scripts/finance-replay-outbox.mjs'),
            '--event-id',
            id,
            '--reason',
            reason,
          ],
          {
            cwd: root,
            env: { ...process.env, NODE_ENV: 'test', WOLFARI_REPLAY_ENV_FILE: envFile },
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 16384,
          },
        );
        assert.equal(expectedExit, 0);
      } catch (error) {
        if (expectedExit === 0) throw error;
        assert.equal(error.code, expectedExit);
        result = error;
      }
      assert(!String(result.stdout).includes(privateMarker));
      assert(!String(result.stderr).includes(privateMarker));
    };
    const replay = await insert(makeEvent('ClosureRequested'), 'FAILED', 3);
    await cli(replay.event_id, 'test-ticket-150');
    const reset = await state(replay.event_id);
    assert.equal(reset.status, 'PENDING');
    assert.equal(reset.attempt_count, 0);
    assert.equal(reset.last_error, 'OPERATOR_REPLAY:test-ticket-150');
    assert.deepEqual(immutable(reset), replay);
    await service.runOnce();
    await verifyPublished([replay]);
    const published = await state(replay.event_id);
    await cli(replay.event_id, 'published-refused', 1);
    assert.deepEqual(await state(replay.event_id), published);
    await cli(invalid[0].event_id, 'invalid-refused', 1);
    assert.equal((await state(invalid[0].event_id)).status, 'FAILED');
    await cli('not-a-uuid', 'invalid-id', 1);
    await cli(replay.event_id, 'bad reason', 1);
    const wrongEnv = resolve(directory, 'wrong-replay.env');
    await writeFile(
      wrongEnv,
      'NODE_ENV=test\nDATABASE_URL=postgresql://identity_app:synthetic@127.0.0.1:9/identity_db\n',
    );
    await cli(replay.event_id, 'wrong-database', 1, wrongEnv);
    await writeFile(wrongEnv, `NODE_ENV=production\nDATABASE_URL=${connectionString}\n`);
    await cli(replay.event_id, 'production-refused', 1, wrongEnv);
    pass(
      'operator CLI replays only an explicit valid FAILED Finance event and preserves its identity and reason',
    );

    stage = 'broker-recovery';
    const durable = await insert(makeEvent('ContributionUpdated'));
    await service.runOnce(); // Leave its persistent message in the durable capture queue across restart.
    await closeCapture();
    await docker(['stop', 'rabbitmq']);
    const outage = await insert(makeEvent('ContributionRequested'));
    await bounded(service.runOnce(), 'BROKER_OUTAGE');
    assert.equal((await state(outage.event_id)).status, 'PENDING');
    assert.equal((await state(outage.event_id)).published_at, null);
    await startTestService(project, 'rabbitmq');
    await waitFor(openCapture, 'BROKER_RECONNECT', 90000);
    const surviving = await messages();
    assert.deepEqual(
      surviving.map((item) => item.event.event_id),
      [durable.event_id],
    );
    await due(outage.event_id);
    await waitFor(async () => {
      await service.runOnce();
      const row = await state(outage.event_id);
      if (row.status === 'PUBLISHED') return true;
      await due(outage.event_id);
      return false;
    }, 'PUBLISHER_RECONNECT');
    await verifyPublished([outage]);
    pass(
      'broker outage retains pending work; reconnect publishes it and durable confirmed messages survive restart',
    );

    stage = 'business-invariants';
    assert.deepEqual(await businessSnapshot(), beforeBusiness);
    for (const [id, event] of originals) assert.deepEqual(immutable(await state(id)), event);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n,
      originals.size,
    );
    pass(
      'publisher changes only delivery metadata: all event envelopes and 16 other Finance business tables remain unchanged',
    );
    console.log(
      `PASS finance:outbox:test completed ${checks} groups (capture queue only; no Automation consumer).`,
    );
  } catch (error) {
    let detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    for (const [key, value] of Object.entries(env ?? {}))
      if (/PASS|SECRET|TOKEN|KEY/.test(key) && value)
        detail = detail.replaceAll(String(value), '[REDACTED]');
    detail = detail.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    console.error(`FAIL finance:outbox:test [${stage}]: ${detail.slice(-8000)}`);
    process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await bounded(exited, 'FINAL_CHILD_EXIT').catch(() => {});
    }
    for (const service of services)
      await bounded(service.onApplicationShutdown(), 'PUBLISHER_CLOSE').catch(() => {});
    await closeCapture();
    await bounded(pool?.end() ?? Promise.resolve(), 'POOL_CLOSE').catch(() => {});
    if (created && /^wolfari-test-[a-f0-9]{12}$/.test(project))
      await docker(['down', '--volumes', '--remove-orphans']).catch(() => {
        process.exitCode = 1;
      });
    if (directory) {
      const target = resolve(directory),
        cache = resolve(root, '.cache');
      if (dirname(target) !== cache || !target.startsWith(resolve(cache, 'finance-outbox-test-')))
        throw new Error('UNSAFE_OUTBOX_FIXTURE_CLEANUP');
      await rm(target, { recursive: true, force: true });
    }
  }
}

if (process.argv.includes('--crash-worker'))
  crashWorker().catch(() => {
    process.exitCode = 1;
  });
else await main();
