import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PriceAlertRepository } = require('../../dist/price-watch/price-alert.repository.js');
const {
  PriceWatchLifecycleRepository,
} = require('../../dist/price-watch/price-watch-lifecycle.repository.js');
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

function event(type, aggregateId, version, tripId, userId = undefined) {
  const membership = type === 'MemberLeft' || type === 'MemberRemoved';
  return {
    event_id: randomUUID(),
    event_type: type,
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    producer: 'Trip',
    aggregate_type: membership ? 'Membership' : 'Trip',
    aggregate_id: aggregateId,
    aggregate_version: version,
    correlation_id: randomUUID(),
    causation_id: null,
    operation_id: null,
    trip_id: tripId,
    actor_user_id: userId ?? null,
    system_actor: userId ? null : 'Trip',
    payload: membership
      ? { trip_id: tripId, user_id: userId, membership_revision: version }
      : type === 'TripDeleted'
        ? { trip_id: tripId, export_revision: version, deleted_at: new Date().toISOString() }
        : { trip_id: tripId, export_revision: version },
  };
}

/** Called by db:test after Automation V004. */
export async function checkPriceAlertRepository(client) {
  const database = {
    query: client.query.bind(client),
    withTransaction: (work) => work(client),
  };
  const alerts = new PriceAlertRepository(database);
  const lifecycle = new PriceWatchLifecycleRepository(database);
  const worker = new PriceWatchWorkerRepository(database);
  let stage = 'SETUP';
  await client.query('BEGIN');
  try {
    const tripA = randomUUID();
    const tripB = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const membershipA = randomUUID();
    const oldMembershipB = randomUUID();
    const newMembershipB = randomUUID();
    const group = (
      await client.query(
        `INSERT INTO price_query_groups(
           provider,transport_type,canonical_key,origin,destination,departure_date,
           passenger_count,cabin_class,currency,params,active,next_check_at
         ) VALUES('MOCK_FLIGHT','FLIGHT',$1,'DAD','SGN','2099-11-01',1,
           'ECONOMY','VND',$2::jsonb,true,clock_timestamp()) RETURNING id`,
        [`alert-${randomUUID()}`, JSON.stringify(query)],
      )
    ).rows[0];
    const watchA = (
      await client.query(
        `INSERT INTO price_watches(
           query_group_id,user_id,trip_id,owner_membership_id,threshold_price,currency,
           status,expires_at,client_request_id,request_hash
         ) VALUES($1,$2,$3,$4,1500000,'VND','ACTIVE','2099-11-01T02:00:00Z',$5,'a')
         RETURNING id`,
        [group.id, userA, tripA, membershipA, randomUUID()],
      )
    ).rows[0];
    const watchB = (
      await client.query(
        `INSERT INTO price_watches(
           query_group_id,user_id,trip_id,owner_membership_id,threshold_price,currency,
           status,expires_at,client_request_id,request_hash
         ) VALUES($1,$2,$3,$4,1300000,'VND','ACTIVE','2099-11-01T02:00:00Z',$5,'b')
         RETURNING id`,
        [group.id, userB, tripB, oldMembershipB, randomUUID()],
      )
    ).rows[0];
    const watchBRejoined = (
      await client.query(
        `INSERT INTO price_watches(
           query_group_id,user_id,trip_id,owner_membership_id,threshold_price,currency,
           status,expires_at,client_request_id,request_hash
         ) VALUES($1,$2,$3,$4,1200000,'VND','ACTIVE','2099-11-01T02:00:00Z',$5,'b-new')
         RETURNING id`,
        [group.id, userB, tripB, newMembershipB, randomUUID()],
      )
    ).rows[0];

    let slot = 0;
    const observation = async (price) => {
      const attempt = (
        await client.query(
          `INSERT INTO price_query_attempts(
             query_group_id,scheduled_slot,status,claim_owner,claim_until,attempt_count,next_attempt_at
           ) VALUES($1,$2,'RUNNING','provider-worker',clock_timestamp()+interval '1 minute',1,clock_timestamp())
           RETURNING id,query_group_id,scheduled_slot,attempt_count`,
          [group.id, new Date(Date.UTC(2098, 0, 1, slot++ * 6)).toISOString()],
        )
      ).rows[0];
      assert.equal(
        await worker.completeSuccess('provider-worker', attempt, {
          price,
          currency: 'VND',
          provider: 'MOCK_FLIGHT',
          fare_metadata: { carrier_code: 'WF' },
        }),
        true,
      );
      return (
        await client.query('SELECT id FROM price_observations WHERE query_attempt_id=$1', [
          attempt.id,
        ])
      ).rows[0].id;
    };

    stage = 'INDEPENDENT_THRESHOLDS';
    await observation('1400000');
    assert.deepEqual(
      (
        await client.query(
          `SELECT watch_id,reason FROM price_alert_candidates
           WHERE status='PENDING' ORDER BY watch_id`,
        )
      ).rows,
      [{ watch_id: watchA.id, reason: 'FIRST' }],
    );
    const first = await alerts.claimNext('alert-a', 30_000);
    assert.equal(first.watch_id, watchA.id);
    assert.equal(await alerts.completeNotification('alert-a', first, membershipA), 'NOTIFIED');
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM notifications WHERE type='PRICE_ALERT'"))
        .rows[0].n,
      1,
    );
    assert.deepEqual(
      (
        await client.query(
          'SELECT last_alert_price::text AS price,alert_armed,version FROM price_watches WHERE id=$1',
          [watchA.id],
        )
      ).rows[0],
      { price: '1400000', alert_armed: false, version: 2 },
    );

    stage = 'COOLDOWN_AND_SUPERSEDE';
    await observation('1500000');
    assert.equal(
      (await client.query('SELECT alert_armed FROM price_watches WHERE id=$1', [watchA.id])).rows[0]
        .alert_armed,
      true,
    );
    await observation('1400000');
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM price_alert_candidates WHERE watch_id=$1 AND status='PENDING'",
          [watchA.id],
        )
      ).rows[0].n,
      0,
    );
    await client.query(
      "UPDATE price_watches SET last_alert_at=clock_timestamp()-interval '24 hours',alert_armed=true WHERE id=$1",
      [watchA.id],
    );
    await observation('1400000');
    assert.equal(
      (
        await client.query(
          "SELECT reason FROM price_alert_candidates WHERE watch_id=$1 AND status='PENDING'",
          [watchA.id],
        )
      ).rows[0].reason,
      'REARMED',
    );
    await observation('1600000');
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM price_alert_candidates WHERE watch_id=$1 AND status IN ('PENDING','PROCESSING')",
          [watchA.id],
        )
      ).rows[0].n,
      0,
    );

    stage = 'LEASE_AND_FIVE_PERCENT';
    await client.query(
      `UPDATE price_watches SET threshold_price=3000000,last_alert_price=2000000,
         last_alert_at=clock_timestamp()-interval '25 hours',alert_armed=false,version=version+1
       WHERE id=$1`,
      [watchA.id],
    );
    await observation('1900000');
    const leased = await alerts.claimNext('alert-a', 30_000);
    assert.equal(leased.watch_id, watchA.id);
    await client.query(
      "UPDATE price_alert_candidates SET claim_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [leased.id],
    );
    const reclaimed = await alerts.claimNext('alert-b', 30_000);
    assert.equal(reclaimed.id, leased.id);
    assert.equal(await alerts.completeNotification('alert-a', leased, membershipA), 'STALE');
    assert.equal(await alerts.completeNotification('alert-b', reclaimed, membershipA), 'NOTIFIED');
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM notifications WHERE type='PRICE_ALERT' AND user_id=$1",
          [userA],
        )
      ).rows[0].n,
      2,
    );

    stage = 'MEMBERSHIP_LIFECYCLE';
    const left = event('MemberLeft', oldMembershipB, 2, tripB, userB);
    assert.equal(await lifecycle.apply(left), 'APPLIED');
    assert.equal(await lifecycle.apply(left), 'DUPLICATE');
    assert.deepEqual(
      (
        await client.query(
          'SELECT id,status FROM price_watches WHERE id=ANY($1::uuid[]) ORDER BY id',
          [[watchB.id, watchBRejoined.id]],
        )
      ).rows,
      [
        { id: watchB.id, status: 'STOPPED' },
        { id: watchBRejoined.id, status: 'ACTIVE' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );

    stage = 'TRIP_LIFECYCLE_ORDERING';
    assert.equal(await lifecycle.apply(event('TripArchived', tripB, 5, tripB)), 'APPLIED');
    assert.equal(
      (
        await client.query('SELECT status,status_reason FROM price_watches WHERE id=$1', [
          watchBRejoined.id,
        ])
      ).rows[0].status_reason,
      'TRIP_ARCHIVED',
    );
    assert.equal(await lifecycle.apply(event('TripReopened', tripB, 6, tripB)), 'APPLIED');
    assert.equal(
      (await client.query('SELECT status FROM price_watches WHERE id=$1', [watchBRejoined.id]))
        .rows[0].status,
      'PAUSED',
    );
    assert.equal(await lifecycle.apply(event('TripArchived', tripB, 5, tripB)), 'STALE');
    await client.query("UPDATE price_watches SET status='ACTIVE',status_reason=NULL WHERE id=$1", [
      watchBRejoined.id,
    ]);
    assert.equal(await lifecycle.apply(event('TripDeleted', tripB, 7, tripB)), 'APPLIED');
    assert.equal(
      (await client.query('SELECT status FROM price_watches WHERE id=$1', [watchBRejoined.id]))
        .rows[0].status,
      'STOPPED',
    );
    assert.equal(await lifecycle.apply(event('TripReopened', tripB, 8, tripB)), 'STALE');
    assert.equal(
      (await client.query('SELECT active FROM price_query_groups WHERE id=$1', [group.id])).rows[0]
        .active,
      true,
    );
  } catch (error) {
    throw new Error(`PRICE_ALERT_DB_${stage}`, { cause: error });
  } finally {
    await client.query('ROLLBACK');
  }
}
