import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';

const require = createRequire(import.meta.url);
const {
  PriceWatchWorkerRepository,
} = require('../../dist/price-watch/price-watch-worker.repository.js');

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

/** Called by the isolated db:test runner after Automation V003. */
export async function checkPriceWatchWorkerRepository(client, connectionString) {
  const database = {
    query: client.query.bind(client),
    withTransaction: (work) => work(client),
  };
  const repository = new PriceWatchWorkerRepository(database);
  let stage = 'SETUP';
  await client.query('BEGIN');
  try {
    const group = (
      await client.query(
        `INSERT INTO price_query_groups(
         provider,transport_type,canonical_key,origin,destination,departure_date,passenger_count,
         cabin_class,currency,params,active,next_check_at
       ) VALUES('MOCK_FLIGHT','FLIGHT',$1,'DAD','SGN','2099-11-01',1,'ECONOMY','VND',$2::jsonb,true,$3)
       RETURNING id`,
        [`worker-${randomUUID()}`, JSON.stringify(query), '2026-10-22T12:00:00.000Z'],
      )
    ).rows[0];
    const watch = (
      await client.query(
        `INSERT INTO price_watches(
         query_group_id,user_id,trip_id,owner_membership_id,threshold_price,currency,status,
         expires_at,client_request_id,request_hash
       ) VALUES($1,$2,$3,$4,2000000,'VND','ACTIVE','2099-11-01T02:00:00.000Z',$5,'worker')
       RETURNING id`,
        [group.id, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      )
    ).rows[0];

    stage = 'SCHEDULE';
    const scheduled = await repository.scheduleDue(new Date('2026-10-22T12:30:00.000Z'), 10);
    assert.equal(scheduled.attemptsCreated, 1);
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM price_query_attempts WHERE query_group_id=$1',
          [group.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await repository.scheduleDue(new Date('2026-10-22T12:30:00.000Z'), 10)).attemptsCreated,
      0,
    );
    await client.query(
      "UPDATE price_query_attempts SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE query_group_id=$1 AND status='PENDING'",
      [group.id],
    );

    stage = 'SUCCESS';
    const first = await repository.claimNext('worker-a', 30_000);
    assert.equal(first.query_group_id, group.id);
    assert.equal(first.attempt_count, 1);
    assert.equal(first.scheduled_slot, '2026-10-22T12:00:00.000Z');
    assert.equal(
      await repository.completeSuccess('worker-a', first, {
        price: '1500000',
        currency: 'VND',
        provider: 'MOCK_FLIGHT',
        fare_metadata: { carrier_code: 'WF' },
      }),
      true,
    );
    assert.equal(
      await repository.completeSuccess('worker-a', first, {
        price: '1400000',
        currency: 'VND',
        provider: 'MOCK_FLIGHT',
        fare_metadata: {},
      }),
      false,
    );
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM price_observations WHERE query_attempt_id=$1',
          [first.id],
        )
      ).rows[0].n,
      1,
    );

    stage = 'RECLAIM';
    assert.equal(
      (await repository.scheduleDue(new Date('2026-10-22T18:01:00.000Z'), 10)).attemptsCreated,
      1,
    );
    await client.query(
      "UPDATE price_query_attempts SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE query_group_id=$1 AND status='PENDING'",
      [group.id],
    );
    const leased = await repository.claimNext('worker-a', 30_000);
    await client.query(
      "UPDATE price_query_attempts SET claim_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [leased.id],
    );
    const reclaimed = await repository.claimNext('worker-b', 30_000);
    assert.equal(reclaimed.id, leased.id);
    assert.equal(reclaimed.attempt_count, 2);
    assert.equal(await repository.completeNoResult('worker-a', leased), false);
    assert.equal(await repository.completeNoResult('worker-b', reclaimed), true);
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM price_observations WHERE query_attempt_id=$1',
          [leased.id],
        )
      ).rows[0].n,
      0,
    );

    stage = 'RETRY';
    assert.equal(
      (await repository.scheduleDue(new Date('2026-10-23T00:01:00.000Z'), 10)).attemptsCreated,
      1,
    );
    await client.query(
      "UPDATE price_query_attempts SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE query_group_id=$1 AND status='PENDING'",
      [group.id],
    );
    const retrying = await repository.claimNext('worker-a', 30_000);
    assert.equal(
      await repository.completeFailure('worker-a', retrying, 'PROVIDER_TIMEOUT', true),
      'RETRY',
    );
    assert.equal(await repository.claimNext('worker-b', 30_000), undefined);
    await client.query(
      "UPDATE price_query_attempts SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [retrying.id],
    );
    const secondCall = await repository.claimNext('worker-b', 30_000);
    assert.equal(secondCall.id, retrying.id);
    assert.equal(secondCall.attempt_count, 2);
    assert.equal(
      await repository.completeFailure('worker-b', secondCall, 'PROVIDER_RESPONSE_INVALID', false),
      'FAILED',
    );
    stage = 'EXHAUSTED_LEASE';
    const exhausted = (
      await client.query(
        `INSERT INTO price_query_attempts(
         query_group_id,scheduled_slot,status,claim_owner,claim_until,attempt_count,next_attempt_at
       ) VALUES($1,'2026-10-23T06:00:00.000Z','RUNNING','dead-worker',
         clock_timestamp()-interval '1 second',6,clock_timestamp()) RETURNING id`,
        [group.id],
      )
    ).rows[0];
    assert.equal(await repository.failExhaustedLeases(10), 1);
    assert.deepEqual(
      (
        await client.query(
          'SELECT status,error_code,claim_owner FROM price_query_attempts WHERE id=$1',
          [exhausted.id],
        )
      ).rows[0],
      { status: 'FAILED', error_code: 'LEASE_EXHAUSTED', claim_owner: null },
    );

    stage = 'EXPIRY';
    await client.query(
      "UPDATE price_watches SET expires_at='2026-10-23T00:30:00.000Z' WHERE id=$1",
      [watch.id],
    );
    const expiry = await repository.scheduleDue(new Date('2026-10-23T06:01:00.000Z'), 10);
    assert.equal(expiry.watchesExpired, 1);
    assert.equal(
      (
        await client.query('SELECT status,status_reason,version FROM price_watches WHERE id=$1', [
          watch.id,
        ])
      ).rows[0].status,
      'EXPIRED',
    );
    assert.deepEqual(
      (
        await client.query('SELECT active,next_check_at FROM price_query_groups WHERE id=$1', [
          group.id,
        ])
      ).rows[0],
      { active: false, next_check_at: null },
    );
  } catch {
    throw new Error(`PRICE_WATCH_WORKER_DB_${stage}`);
  } finally {
    await client.query('ROLLBACK');
  }

  const groupId = randomUUID();
  await client.query(
    `INSERT INTO price_query_groups(
       id,provider,transport_type,canonical_key,origin,destination,departure_date,passenger_count,
       cabin_class,currency,params,active,next_check_at
     ) VALUES($1,'MOCK_FLIGHT','FLIGHT',$2,'DAD','SGN','2099-11-01',1,'ECONOMY','VND',$3::jsonb,true,$4)`,
    [groupId, `concurrent-${randomUUID()}`, JSON.stringify(query), '2026-10-22T12:00:00.000Z'],
  );
  await client.query(
    `INSERT INTO price_watches(
       query_group_id,user_id,trip_id,owner_membership_id,threshold_price,currency,status,
       expires_at,client_request_id,request_hash
     ) VALUES($1,$2,$3,$4,2000000,'VND','ACTIVE','2099-11-01T02:00:00.000Z',$5,'concurrent')`,
    [groupId, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
  );
  const pool = new pg.Pool({ connectionString, max: 4 });
  const concurrentDatabase = {
    query: pool.query.bind(pool),
    withTransaction: async (work) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await work(connection);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
  try {
    const firstWorker = new PriceWatchWorkerRepository(concurrentDatabase);
    const secondWorker = new PriceWatchWorkerRepository(concurrentDatabase);
    const results = await Promise.all([
      firstWorker.scheduleDue(new Date('2026-10-22T12:30:00.000Z'), 10),
      secondWorker.scheduleDue(new Date('2026-10-22T12:30:00.000Z'), 10),
    ]);
    assert.equal(
      results.reduce((total, item) => total + item.attemptsCreated, 0),
      1,
    );
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM price_query_attempts WHERE query_group_id=$1',
          [groupId],
        )
      ).rows[0].n,
      1,
    );
  } catch {
    throw new Error('PRICE_WATCH_WORKER_DB_CONCURRENT_SCHEDULE');
  } finally {
    await pool.end();
    await client.query('DELETE FROM price_query_attempts WHERE query_group_id=$1', [groupId]);
    await client.query('DELETE FROM price_watches WHERE query_group_id=$1', [groupId]);
    await client.query('DELETE FROM price_query_groups WHERE id=$1', [groupId]);
  }
}
