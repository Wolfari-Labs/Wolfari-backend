import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';

const require = createRequire(import.meta.url);
const {
  PriceWatchRepository,
} = require('../apps/automation-service/dist/price-watch/price-watch.repository.js');
const {
  PriceWatchWorkerRepository,
} = require('../apps/automation-service/dist/price-watch/price-watch-worker.repository.js');
const {
  PriceWatchWorkerService,
} = require('../apps/automation-service/dist/price-watch/price-watch-worker.service.js');
const {
  PriceAlertRepository,
} = require('../apps/automation-service/dist/price-watch/price-alert.repository.js');

const quote = { price: '1500000', currency: 'VND', provider: 'MOCK_FLIGHT', fare_metadata: {} };
const query = {
  provider: 'MOCK_FLIGHT',
  transport_type: 'FLIGHT',
  origin: 'DAD',
  destination: 'SGN',
  departure_date: '2099-11-01',
  return_date: null,
  journey_type: 'ONE_WAY',
  adults: 1,
  children: 0,
  infants: 0,
  passenger_count: 1,
  cabin_class: 'ECONOMY',
  currency: 'VND',
  departure_at: '2099-11-01T02:00:00.000Z',
};

async function bounded(work, label, milliseconds = 12000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PRICE_WATCH_TIMEOUT_${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { release, wait: (label) => bounded(promise, label) };
}

async function waitBlocked(observer, waiter, blocker) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const row = (await observer.query('SELECT pg_blocking_pids($1::int) AS pids', [waiter]))
      .rows[0];
    if (row.pids.includes(blocker)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('PRICE_WATCH_EXPECTED_DATABASE_BLOCK_NOT_OBSERVED');
}

function database(pool, connection, afterQuery, deadlocks = []) {
  const run = async (client, text, values) => {
    const result = await client.query(text, values);
    await afterQuery?.(text, values, result);
    return result;
  };
  return {
    query: connection ? (text, values) => run(connection, text, values) : pool.query.bind(pool),
    withTransaction: async (work) => {
      const client = connection ?? (await pool.connect());
      try {
        await client.query('BEGIN');
        const result = await work({ query: (text, values) => run(client, text, values) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '40P01') deadlocks.push(error.code);
        throw error;
      } finally {
        if (!connection) client.release();
      }
    },
  };
}

async function fixture(connectionString, work) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 7000,
    idle_in_transaction_session_timeout: 15000,
  });
  const groupIds = [];
  const watchIds = [];
  const db = database(pool);
  const watches = new PriceWatchRepository(db);
  const worker = new PriceWatchWorkerRepository(db);
  const tripId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const context = { tripId, userId, membershipId };
  const makeWatch = async (groupId) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO price_watches(
      id,query_group_id,user_id,trip_id,owner_membership_id,threshold_price,currency,
      status,expires_at,client_request_id,request_hash
    ) VALUES($1,$2,$3,$4,$5,2000000,'VND','ACTIVE','2099-11-01T02:00:00Z',$6,'concurrency-fixture')`,
      [id, groupId, userId, tripId, membershipId, randomUUID()],
    );
    watchIds.push(id);
    return id;
  };
  const makeGroup = async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO price_query_groups(
      id,provider,transport_type,canonical_key,origin,destination,departure_date,
      passenger_count,cabin_class,currency,params,active,next_check_at
    ) VALUES($1,'MOCK_FLIGHT','FLIGHT',$2,'DAD','SGN','2099-11-01',1,'ECONOMY','VND',
      $3::jsonb,true,clock_timestamp()-interval '1 second')`,
      [id, `concurrency-${randomUUID()}`, JSON.stringify(query)],
    );
    groupIds.push(id);
    return { groupId: id, watchId: await makeWatch(id) };
  };
  const schedule = async (groupId) => {
    const now = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now;
    await worker.scheduleDue(now, 100);
    const attempt = (
      await pool.query('SELECT id FROM price_query_attempts WHERE query_group_id=$1', [groupId])
    ).rows;
    assert.equal(attempt.length, 1);
    await pool.query(
      "UPDATE price_query_attempts SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [attempt[0].id],
    );
    return attempt[0].id;
  };
  const state = async (id) =>
    (
      await pool.query(
        'SELECT status,claim_owner,claim_until,attempt_count FROM price_query_attempts WHERE id=$1',
        [id],
      )
    ).rows[0];
  const disable = async (watchId, mode) => {
    if (mode === 'PAUSED' || mode === 'STOPPED') {
      await watches.changeStatus(
        watchId,
        1,
        mode,
        mode === 'STOPPED' ? 'USER_STOPPED' : null,
        () => {},
      );
    } else {
      await pool.query(
        "UPDATE price_watches SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [watchId],
      );
      if (mode === 'EXPIRED') {
        const now = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now;
        await worker.scheduleDue(now, 100);
      }
    }
  };
  try {
    await work({
      pool,
      db,
      watches,
      worker,
      context,
      makeGroup,
      makeWatch,
      schedule,
      state,
      disable,
    });
  } finally {
    try {
      // Only rows created by this fixture, in the harness-owned disposable database.
      if (watchIds.length) {
        await pool.query('DELETE FROM notifications WHERE source_id=ANY($1::text[])', [watchIds]);
        await pool.query('DELETE FROM price_alert_candidates WHERE watch_id=ANY($1::uuid[])', [
          watchIds,
        ]);
      }
      if (groupIds.length) {
        await pool.query('DELETE FROM price_observations WHERE query_group_id=ANY($1::uuid[])', [
          groupIds,
        ]);
        await pool.query('DELETE FROM price_query_attempts WHERE query_group_id=ANY($1::uuid[])', [
          groupIds,
        ]);
        await pool.query('DELETE FROM price_watches WHERE query_group_id=ANY($1::uuid[])', [
          groupIds,
        ]);
        await pool.query('DELETE FROM price_query_groups WHERE id=ANY($1::uuid[])', [groupIds]);
      }
    } finally {
      await bounded(pool.end(), 'POOL_END');
    }
  }
}

async function inactiveClaim(f, mode, reclaim) {
  const row = await f.makeGroup();
  const id = await f.schedule(row.groupId);
  if (reclaim) {
    const first = await f.worker.claimNext('old-worker', 30000);
    assert.equal(first.id, id);
    await f.pool.query(
      "UPDATE price_query_attempts SET claim_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id],
    );
  }
  await f.disable(row.watchId, mode);
  const before = await f.state(id);
  assert.equal(await f.worker.claimNext('must-not-dispatch', 30000), undefined);
  assert.deepEqual(
    await f.state(id),
    before,
    'ineligible attempts must not consume a provider generation',
  );
}

async function resumeClaim(f) {
  const row = await f.makeGroup();
  const id = await f.schedule(row.groupId);
  await f.disable(row.watchId, 'PAUSED');
  assert.equal(await f.worker.claimNext('paused', 30000), undefined);
  await f.watches.changeStatus(row.watchId, 2, 'ACTIVE', null, () => {});
  const claimed = await f.worker.claimNext('resumed', 30000);
  assert.equal(claimed.id, id);
  assert.equal(claimed.attempt_count, 1);
}

async function sharedGroupClaim(f) {
  const row = await f.makeGroup();
  await f.makeWatch(row.groupId);
  const id = await f.schedule(row.groupId);
  await f.disable(row.watchId, 'PAUSED');
  assert.equal((await f.worker.claimNext('shared', 30000)).id, id);
}

async function skipIneligibleHead(f) {
  const inactive = await f.makeGroup();
  const oldId = await f.schedule(inactive.groupId);
  await f.disable(inactive.watchId, 'PAUSED');
  await f.pool.query(
    "UPDATE price_query_attempts SET next_attempt_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
    [oldId],
  );
  const eligible = await f.makeGroup();
  const id = await f.schedule(eligible.groupId);
  assert.equal((await f.worker.claimNext('later-eligible', 30000)).id, id);
  assert.equal((await f.state(oldId)).attempt_count, 0);
}

async function inFlightStop(f) {
  const row = await f.makeGroup();
  await f.schedule(row.groupId);
  const claimed = await f.worker.claimNext('in-flight', 30000);
  await f.disable(row.watchId, 'STOPPED');
  assert.equal(await f.worker.completeSuccess('in-flight', claimed, quote), true);
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM price_observations WHERE query_attempt_id=$1',
        [claimed.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM price_alert_candidates WHERE watch_id=$1',
        [row.watchId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await f.pool.query('SELECT count(*)::int AS n FROM notifications WHERE source_id=$1', [
        row.watchId,
      ])
    ).rows[0].n,
    0,
  );
}

async function realDeadlockRecovery(f) {
  const row = await f.makeGroup();
  const attemptId = await f.schedule(row.groupId);
  const a = await f.pool.connect();
  const b = await f.pool.connect();
  const observer = await f.pool.connect();
  const watchLocked = gate();
  const resumeMutation = gate();
  const groupLocked = gate();
  const deadlocks = [];
  let firstWatchLock = true;
  let firstGroupLock = true;
  let providerCalls = 0;
  let mutation;
  let cycle;
  try {
    const aPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.notEqual(aPid, bPid);
    const mutationDb = database(
      f.pool,
      a,
      async (sql) => {
        if (firstWatchLock && sql.includes('FOR UPDATE OF w')) {
          firstWatchLock = false;
          watchLocked.release();
          await resumeMutation.wait('MUTATION_GATE');
        }
      },
      deadlocks,
    );
    const workerDb = database(
      f.pool,
      b,
      async (sql) => {
        if (
          firstGroupLock &&
          sql.includes('SELECT id FROM price_query_groups WHERE id=$1 FOR UPDATE')
        ) {
          firstGroupLock = false;
          groupLocked.release();
        }
      },
      deadlocks,
    );
    const writer = new PriceWatchRepository(mutationDb);
    const worker = new PriceWatchWorkerRepository(workerDb);
    const values = {
      NODE_ENV: 'test',
      PRICE_WATCH_WORKER_ENABLED: 'false',
      PRICE_WATCH_WORKER_BATCH_SIZE: '1',
      PRICE_WATCH_ATTEMPT_LEASE_MS: '30000',
      PRICE_WATCH_PROVIDER_TIMEOUT_MS: '5000',
    };
    const service = new PriceWatchWorkerService({ get: (key) => values[key] }, worker, {
      fetch: async () => {
        providerCalls++;
        return { kind: 'SUCCESS', ...quote };
      },
    });
    // Attach rejection handlers immediately while the database barriers are observed.
    mutation = writer
      .changeStatus(row.watchId, 1, 'PAUSED', null, () => {})
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await watchLocked.wait('WATCH_LOCK');
    cycle = service.runCycle().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await groupLocked.wait('GROUP_LOCK');
    await waitBlocked(observer, bPid, aPid);
    resumeMutation.release();
    const results = await bounded(Promise.all([mutation, cycle]), 'DEADLOCK_RECOVERY');
    assert(deadlocks.length >= 1, 'the fixture must exercise a real PostgreSQL 40P01');
    for (const result of results)
      assert.equal(
        result.error,
        undefined,
        'both operations must recover from the database deadlock',
      );
    assert.equal(providerCalls, 1, 'database retry must reuse the fetched quote');
    // If the mutation was the deadlock victim, the provider can commit its candidate
    // before the pause retry. Its captured version/state must fail final delivery.
    const alerts = new PriceAlertRepository(f.db);
    const candidate = await alerts.claimNext('post-pause-check', 30000);
    if (candidate) {
      assert.equal(candidate.watch_id, row.watchId);
      assert.equal(
        await alerts.completeNotification('post-pause-check', candidate, f.context.membershipId),
        'SUPPRESSED',
      );
    }
    assert.equal(
      (
        await observer.query('SELECT count(*)::int AS n FROM notifications WHERE source_id=$1', [
          row.watchId,
        ])
      ).rows[0].n,
      0,
    );
    assert.deepEqual(
      (await observer.query('SELECT status,version FROM price_watches WHERE id=$1', [row.watchId]))
        .rows[0],
      { status: 'PAUSED', version: 2 },
    );
    assert.deepEqual(
      (
        await observer.query('SELECT status,attempt_count FROM price_query_attempts WHERE id=$1', [
          attemptId,
        ])
      ).rows[0],
      { status: 'SUCCEEDED', attempt_count: 1 },
    );
    assert.equal(
      (
        await observer.query(
          'SELECT count(*)::int AS n FROM price_observations WHERE query_attempt_id=$1',
          [attemptId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS n FROM price_alert_candidates WHERE watch_id=$1 AND status IN ('PENDING','PROCESSING')",
          [row.watchId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    resumeMutation.release();
    await bounded(Promise.all([mutation, cycle].filter(Boolean)), 'DEADLOCK_SETTLE').catch(
      () => {},
    );
    // These connections belong only to this disposable fixture.
    a.release(true);
    b.release(true);
    observer.release(true);
  }
}

/** Uses only the caller's isolated db:test database; never connects to a development database. */
export async function checkPriceWatchConcurrency(connectionString) {
  const cases = [];
  for (const mode of ['PAUSED', 'STOPPED', 'ELAPSED', 'EXPIRED']) {
    for (const reclaim of [false, true])
      cases.push([
        `${mode}_${reclaim ? 'RECLAIM' : 'PENDING'}`,
        (f) => inactiveClaim(f, mode, reclaim),
      ]);
  }
  cases.push(
    ['RESUME_EXISTING_ATTEMPT', resumeClaim],
    ['SHARED_ACTIVE_WATCH', sharedGroupClaim],
    ['SKIP_INELIGIBLE_HEAD', skipIneligibleHead],
    ['IN_FLIGHT_STOP', inFlightStop],
    ['REAL_DEADLOCK_SINGLE_FETCH', realDeadlockRecovery],
  );
  const failed = [];
  for (const [name, work] of cases) {
    try {
      await fixture(connectionString, work);
      console.log(`PASS Price Watch regression ${name}`);
    } catch (error) {
      failed.push(name);
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(
        `FAIL Price Watch regression ${name}: ${error.code ?? error.name ?? 'ERROR'}`,
        detail.replaceAll(connectionString, '[connection redacted]'),
      );
    }
  }
  assert.deepEqual(failed, [], 'Price Watch concurrency and dispatch eligibility regressions');
}
