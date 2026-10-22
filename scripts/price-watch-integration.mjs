import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runPriceWatchTests({ request, query, account, bearer, tripBody, pass }) {
  const firstOwner = await account('Price Watch First Owner');
  const secondOwner = await account('Price Watch Second Owner');
  const outsider = await account('Price Watch Outsider');

  const createTrip = async (owner, name) => {
    const key = randomUUID();
    const result = await request('/api/v1/trips', 'POST', tripBody(name, key), {
      ...bearer(owner),
      'idempotency-key': key,
    });
    assert.equal(result.status, 201);
    return result.body.data.id;
  };
  const firstTrip = await createTrip(firstOwner, 'Price Watch A');
  const secondTrip = await createTrip(secondOwner, 'Price Watch B');
  pass('two isolated Trip owners are ready');

  const departure = new Date(Date.now() + 30 * 86_400_000);
  departure.setUTCHours(2, 0, 0, 0);
  const body = {
    provider: 'MOCK_FLIGHT',
    origin: 'DAD',
    destination: 'SGN',
    departure_date: departure.toISOString().slice(0, 10),
    journey_type: 'ONE_WAY',
    passengers: { adults: 2, children: 1, infants: 1 },
    cabin_class: 'ECONOMY',
    currency: 'VND',
    threshold_price: '2500000',
    departure_at: departure.toISOString(),
  };
  const createWatch = (tripId, owner, key, payload = body) =>
    request(`/api/v1/trips/${tripId}/price-watches`, 'POST', payload, {
      ...bearer(owner),
      'idempotency-key': key,
    });

  const firstKey = randomUUID();
  const [first, replay] = await Promise.all([
    createWatch(firstTrip, firstOwner, firstKey),
    createWatch(firstTrip, firstOwner, firstKey),
  ]);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(first.body.data.id, replay.body.data.id);
  assert.equal(
    (
      await createWatch(firstTrip, firstOwner, firstKey, {
        ...body,
        threshold_price: '2400000',
      })
    ).status,
    409,
  );
  pass('concurrent create replays once and key reuse with another intent conflicts');

  const second = await createWatch(secondTrip, secondOwner, randomUUID());
  assert.equal(second.status, 201);
  assert.equal(second.body.data.query_group_id, first.body.data.query_group_id);
  assert.notEqual(second.body.data.id, first.body.data.id);
  assert.equal(
    (await query('automation', 'SELECT count(*)::int AS n FROM price_query_groups'))[0]?.n,
    1,
  );
  pass('identical price inputs across Trips share one query group but retain separate watches');

  assert.equal(
    (await request(`/api/v1/trips/${firstTrip}/price-watches`, 'GET', undefined, bearer(outsider)))
      .status,
    404,
  );
  const page = await request(
    `/api/v1/trips/${firstTrip}/price-watches?limit=1`,
    'GET',
    undefined,
    bearer(firstOwner),
  );
  assert.equal(page.status, 200);
  assert.equal(page.body.data.length, 1);
  pass('Trip access scopes watch listing and hides it from outsiders');

  const noOp = await request(
    `/api/v1/price-watches/${first.body.data.id}`,
    'PATCH',
    {
      expected_version: 1,
      threshold_price: '2500000',
    },
    bearer(firstOwner),
  );
  assert.equal(noOp.status, 200);
  assert.equal(noOp.body.data.version, 1);
  const threshold = await request(
    `/api/v1/price-watches/${first.body.data.id}`,
    'PATCH',
    {
      expected_version: 1,
      threshold_price: '2300000',
    },
    bearer(firstOwner),
  );
  assert.equal(threshold.status, 200);
  assert.equal(threshold.body.data.version, 2);
  assert.equal(
    (
      await request(
        `/api/v1/price-watches/${first.body.data.id}`,
        'PATCH',
        {
          expected_version: 1,
          threshold_price: '2200000',
        },
        bearer(firstOwner),
      )
    ).status,
    409,
  );
  pass('no-op keeps version; real patch increments and stale expected_version conflicts');

  const paused = await request(
    `/api/v1/price-watches/${first.body.data.id}/pause`,
    'POST',
    {
      expected_version: 2,
    },
    bearer(firstOwner),
  );
  assert.equal(paused.status, 200);
  assert.equal(paused.body.data.status, 'PAUSED');
  const resumed = await request(
    `/api/v1/price-watches/${first.body.data.id}/resume`,
    'POST',
    {
      expected_version: 3,
    },
    bearer(firstOwner),
  );
  assert.equal(resumed.status, 200);
  const stopped = await request(
    `/api/v1/price-watches/${first.body.data.id}/stop`,
    'POST',
    {
      expected_version: 4,
    },
    bearer(firstOwner),
  );
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.data.status, 'STOPPED');
  assert.equal(
    (
      await request(
        `/api/v1/price-watches/${first.body.data.id}/resume`,
        'POST',
        {
          expected_version: 5,
        },
        bearer(firstOwner),
      )
    ).status,
    409,
  );
  pass('pause/resume/stop state machine makes STOPPED terminal');

  const observations = await request(
    `/api/v1/price-watches/${first.body.data.id}/observations`,
    'GET',
    undefined,
    bearer(firstOwner),
  );
  assert.equal(observations.status, 200);
  assert.deepEqual(observations.body.data, []);
  pass('H1 observation endpoint is authorized and empty before scheduler/provider H2');

  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [secondTrip]);
  assert.equal(
    (
      await request(
        `/api/v1/trips/${secondTrip}/price-watches`,
        'GET',
        undefined,
        bearer(secondOwner),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/api/v1/price-watches/${second.body.data.id}/pause`,
        'POST',
        {
          expected_version: 1,
        },
        bearer(secondOwner),
      )
    ).status,
    409,
  );
  pass('archived Trip remains readable to its member and rejects writes');
}
