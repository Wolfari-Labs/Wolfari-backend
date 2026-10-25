import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';

export async function runPriceWatchTests({
  request,
  query,
  account,
  bearer,
  tripBody,
  pass,
  brokerUrl,
}) {
  const waitFor = async (work, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const value = await work();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error('PRICE_WATCH_WORKER_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
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
  const [first, replay, second] = await Promise.all([
    createWatch(firstTrip, firstOwner, firstKey),
    createWatch(firstTrip, firstOwner, firstKey),
    createWatch(secondTrip, secondOwner, randomUUID(), {
      ...body,
      threshold_price: '9000000',
    }),
  ]);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(second.status, 201);
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

  const observations = await waitFor(async () => {
    const result = await request(
      `/api/v1/price-watches/${first.body.data.id}/observations`,
      'GET',
      undefined,
      bearer(firstOwner),
    );
    assert.equal(result.status, 200);
    return result.body.data.length ? result : undefined;
  });
  assert.equal(observations.status, 200);
  assert.equal(observations.body.data.length, 1);
  assert.equal(observations.body.data[0].provider, 'MOCK_FLIGHT');
  assert.equal(observations.body.data[0].currency, 'VND');
  assert.equal(observations.body.data[0].fare_metadata.baggage_summary, 'MOCK_DATA');
  assert.equal(
    (await query(
      'automation',
      'SELECT count(*)::int AS n FROM price_query_attempts WHERE query_group_id=$1',
      [first.body.data.query_group_id],
    ))[0]?.n,
    1,
  );
  pass('H2 worker creates one deterministic observation for the shared six-hour slot');

  const alert = await waitFor(
    async () => {
      const rows = await query(
        'automation',
        `SELECT n.status,n.type,n.source_id,w.last_alert_price::text,w.last_alert_at,w.version
         FROM notifications n JOIN price_watches w ON w.id=n.source_id::uuid
         WHERE n.user_id=$1 AND n.type='PRICE_ALERT'`,
        [secondOwner.id],
      );
      return rows[0];
    },
    30_000,
  ).catch(async error => {
    const state = await query(
      'automation',
      `SELECT w.status AS watch_status,w.version,c.status AS candidate_status,
         c.attempt_count,c.last_error
       FROM price_watches w LEFT JOIN price_alert_candidates c ON c.watch_id=w.id
       WHERE w.id=$1 ORDER BY c.created_at DESC NULLS LAST LIMIT 1`,
      [second.body.data.id],
    );
    throw new Error(`PRICE_ALERT_HANDOFF_TIMEOUT ${JSON.stringify(state[0] ?? {})}`, {
      cause: error,
    });
  });
  assert.equal(alert.status, 'AVAILABLE');
  assert.equal(alert.type, 'PRICE_ALERT');
  assert.equal(alert.source_id, second.body.data.id);
  assert.equal(alert.version, 2);
  assert.ok(BigInt(alert.last_alert_price) < 9_000_000n);
  assert.ok(alert.last_alert_at);
  assert.equal(
    (
      await query(
        'automation',
        `SELECT count(*)::int AS n FROM notification_deliveries d
         JOIN notifications n ON n.id=d.notification_id WHERE n.type='PRICE_ALERT'`,
      )
    )[0]?.n,
    0,
  );
  pass('H3 evaluates each watch independently and creates one in-app notification handoff');

  const connection = await amqp.connect(brokerUrl);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange('wolfari.events.v1', 'topic', { durable: true });
  await waitFor(async () => {
    try {
      await channel.checkQueue('wolfari.automation.price-watch.v1');
      return true;
    } catch {
      return false;
    }
  });
  const publishLifecycle = async (type, revision) => {
    const event = {
      event_id: randomUUID(),
      event_type: type,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'Trip',
      aggregate_type: 'Trip',
      aggregate_id: secondTrip,
      aggregate_version: revision,
      correlation_id: randomUUID(),
      causation_id: null,
      operation_id: null,
      trip_id: secondTrip,
      actor_user_id: secondOwner.id,
      system_actor: null,
      payload: { trip_id: secondTrip, export_revision: revision },
    };
    channel.publish('wolfari.events.v1', type, Buffer.from(JSON.stringify(event)), {
      contentType: 'application/json',
      messageId: event.event_id,
      persistent: true,
      mandatory: true,
    });
    await channel.waitForConfirms();
  };
  const archivedRevision = (
    await query(
      'trip',
      'UPDATE trips SET archived_at=now(),export_revision=export_revision+1 WHERE id=$1 RETURNING export_revision',
      [secondTrip],
    )
  )[0].export_revision;
  await publishLifecycle('TripArchived', archivedRevision);
  await waitFor(async () => {
    const rows = await query(
      'automation',
      'SELECT status,status_reason,version FROM price_watches WHERE id=$1',
      [second.body.data.id],
    );
    return rows[0]?.status === 'PAUSED' ? rows[0] : undefined;
  });
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
          expected_version: 3,
        },
        bearer(secondOwner),
      )
    ).status,
    409,
  );
  pass('TripArchived event pauses active watches and archived Trip rejects writes');

  const reopenedRevision = (
    await query(
      'trip',
      'UPDATE trips SET archived_at=NULL,export_revision=export_revision+1 WHERE id=$1 RETURNING export_revision',
      [secondTrip],
    )
  )[0].export_revision;
  await publishLifecycle('TripReopened', reopenedRevision);
  await waitFor(async () => {
    const rows = await query(
      'automation',
      'SELECT state FROM price_watch_trip_lifecycle WHERE trip_id=$1',
      [secondTrip],
    );
    return rows[0]?.state === 'ACTIVE';
  });
  const stillPaused = (
    await query('automation', 'SELECT status,version FROM price_watches WHERE id=$1', [
      second.body.data.id,
    ])
  )[0];
  assert.deepEqual(stillPaused, { status: 'PAUSED', version: 3 });
  const resumedAfterReopen = await request(
    `/api/v1/price-watches/${second.body.data.id}/resume`,
    'POST',
    { expected_version: 3 },
    bearer(secondOwner),
  );
  assert.equal(resumedAfterReopen.status, 200);
  assert.equal(resumedAfterReopen.body.data.status, 'ACTIVE');
  await channel.close();
  await connection.close();
  pass('TripReopened does not auto-resume; the creator resumes explicitly');
}
