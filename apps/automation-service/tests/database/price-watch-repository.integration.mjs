import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PriceWatchRepository } = require('../../dist/price-watch/price-watch.repository.js');

const normalized = (overrides = {}) => {
  const query = {
    provider: 'MOCK_FLIGHT', transport_type: 'FLIGHT', origin: 'DAD', destination: 'SGN',
    departure_date: '2099-11-01', return_date: null, journey_type: 'ONE_WAY',
    adults: 1, children: 0, infants: 0, passenger_count: 1, cabin_class: 'ECONOMY',
    currency: 'VND', departure_at: '2099-11-01T02:00:00.000Z',
    ...(overrides.query ?? {}),
  };
  return {
    query,
    threshold_price: '2000000',
    canonical_key: `key-${query.origin}-${query.destination}-${query.cabin_class}`,
    request_hash: 'request-hash',
    expires_at: query.departure_at,
    ...overrides,
    query,
  };
};

/** Called by the isolated db:test runner after Automation V002. */
export async function checkPriceWatchRepository(client) {
  const database = {
    query: client.query.bind(client),
    withTransaction: (work) => work(client),
  };
  const repository = new PriceWatchRepository(database);
  const first = {
    userId: randomUUID(), tripId: randomUUID(), membershipId: randomUUID(),
    clientRequestId: randomUUID(), value: normalized(),
  };

  await client.query('BEGIN');
  try {
    const created = await repository.create(first);
    assert.equal(created.version, 1);
    assert.equal(created.owner_membership_id, first.membershipId);
    assert.equal(created.query.origin, 'DAD');
    assert.equal((await repository.create(first)).id, created.id);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM price_watches')).rows[0].n, 1);

    await assert.rejects(
      repository.create({ ...first, value: normalized({ request_hash: 'different' }) }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );

    const second = await repository.create({
      userId: randomUUID(), tripId: randomUUID(), membershipId: randomUUID(),
      clientRequestId: randomUUID(), value: normalized({ request_hash: 'second' }),
    });
    assert.equal(second.query_group_id, created.query_group_id);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM price_query_groups')).rows[0].n, 1);

    await client.query(
      `UPDATE price_watches SET last_alert_price=1900000,last_alert_at=now(),alert_armed=false
       WHERE id=$1`,
      [created.id],
    );
    const threshold = await repository.update(
      created.id, 1, normalized({ threshold_price: '1800000' }), () => {},
    );
    assert.equal(threshold.version, 2);
    assert.equal(threshold.last_alert_price, '1900000');
    const flags = (await client.query(
      'SELECT alert_armed,last_alert_at IS NOT NULL AS kept FROM price_watches WHERE id=$1',
      [created.id],
    )).rows[0];
    assert.deepEqual(flags, { alert_armed: true, kept: true });

    const noOp = await repository.update(
      created.id, 2, normalized({ threshold_price: '1800000' }), () => {},
    );
    assert.equal(noOp.version, 2);
    await assert.rejects(
      repository.update(created.id, 1, normalized({ threshold_price: '1700000' }), () => {}),
      (error) => error.code === 'VERSION_CONFLICT' && error.details.current_version === 2,
    );

    const movedValue = normalized({
      query: { origin: 'HAN', destination: 'CXR' },
      canonical_key: 'key-HAN-CXR-ECONOMY',
      request_hash: 'moved',
      threshold_price: '1800000',
    });
    const moved = await repository.update(created.id, 2, movedValue, () => {});
    assert.notEqual(moved.query_group_id, second.query_group_id);
    assert.equal((await repository.find(second.id)).query.origin, 'DAD');

    const paused = await repository.changeStatus(moved.id, 3, 'PAUSED', null, () => {});
    assert.equal(paused.status, 'PAUSED');
    assert.equal(paused.version, 4);
    await client.query('UPDATE price_watches SET version=2147483647 WHERE id=$1', [moved.id]);
    await assert.rejects(
      repository.changeStatus(moved.id, 2147483647, 'ACTIVE', null, () => {}),
      (error) => error.code === 'STATE_CONFLICT',
    );

    const attempt = (await client.query(
      `INSERT INTO price_query_attempts(query_group_id,scheduled_slot,status)
       VALUES($1,now(),'SUCCEEDED') RETURNING id`, [moved.query_group_id],
    )).rows[0];
    await client.query(
      `INSERT INTO price_observations(
        query_group_id,query_attempt_id,price,currency,provider,fare_metadata,observed_at,fetched_at
      ) VALUES($1,$2,1500000,'VND','MOCK_FLIGHT',
        '{"carrier_code":"VN","private_url":"secret"}',now(),now())`,
      [moved.query_group_id, attempt.id],
    );
    const observations = await repository.listObservations(moved.query_group_id, 10);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].price, '1500000');
    assert.equal((await repository.listObservations(second.query_group_id, 10)).length, 0);
  } finally {
    await client.query('ROLLBACK');
  }
}
