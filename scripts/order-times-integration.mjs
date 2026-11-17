import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runOrderTimeScenarios({ request, query, owner, bearer, tripBody, pass }) {
  const created = await request(
    '/api/v1/trips',
    'POST',
    {
      ...tripBody('Reorder time reconciliation'),
      start_at: '2027-01-01T17:00:00Z',
      end_at: '2027-01-04T17:00:00Z',
      timezone: 'Asia/Ho_Chi_Minh',
    },
    bearer(owner),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const trip = created.body.data,
    root = `/api/v1/trips/${trip.id}`;
  let version = trip.plan_version;
  const get = async () =>
    (await request(`${root}/plan`, 'GET', undefined, bearer(owner))).body.data;
  const send = async (method, path, body, key = randomUUID(), expected = version) => {
    const response = await request(
      `${root}/${path}`,
      method,
      { ...body, expected_plan_version: expected },
      { ...bearer(owner), 'idempotency-key': key, 'x-correlation-id': key },
    );
    if (response.status < 300) version = response.body.data.plan_version;
    return response;
  };
  for (const [title, starts_at, ends_at, scheduled_date] of [
    ['Midnight', '2027-01-01T17:30:00Z', '2027-01-01T18:00:00Z', null],
    ['Seven', '2027-01-02T00:00:00Z', '2027-01-02T00:30:00Z', null],
    ['Eight overnight', '2027-01-02T01:00:00Z', '2027-01-02T18:00:00Z', null],
    ['Day only', null, null, '2027-01-02'],
    ['Next day', '2027-01-03T00:00:00Z', '2027-01-03T01:00:00Z', null],
    ['Unscheduled', null, null, null],
  ]) {
    const position = (await get()).activities.length;
    const response = await send('POST', 'activities', {
      title,
      activity_type: 'OTHER',
      position,
      starts_at,
      ends_at,
      scheduled_date,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }
  let snapshot = await get();
  const [midnight, seven, eight, day, next, draft] = snapshot.activities;
  assert.equal(
    (await send('PATCH', `activities/${seven.id}/completion`, { status: 'COMPLETED' })).status,
    200,
  );
  snapshot = await get();
  const completed = snapshot.activities.find((a) => a.id === seven.id);
  const before = async () =>
    (
      await query(
        'trip',
        `SELECT
    (SELECT count(*)::int FROM trip_audit_logs WHERE trip_id=$1) AS audits,
    (SELECT count(*)::int FROM outbox_events WHERE trip_id=$1) AS events,
    (SELECT count(*)::int FROM trip_operations WHERE trip_id=$1) AS receipts,
    plan_version,export_revision FROM trips WHERE id=$1`,
        [trip.id],
      )
    )[0];
  const counts = await before(),
    key = randomUUID(),
    expected = version;
  const activity_ids = [eight.id, day.id, seven.id, midnight.id, next.id, draft.id];
  // Inject a failure after both order and times have changed: all must roll back.
  await query(
    'trip',
    `CREATE FUNCTION test_order_time_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'intentional order rollback'; END $$;
    CREATE TRIGGER test_order_time_rollback BEFORE INSERT ON trip_operations
    FOR EACH ROW EXECUTE FUNCTION test_order_time_rollback()`,
  );
  try {
    const failed = await send('PUT', 'activities/order', { activity_ids }, key, expected);
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.deepEqual(await get(), snapshot);
    assert.deepEqual(await before(), counts);
  } finally {
    await query(
      'trip',
      'DROP TRIGGER test_order_time_rollback ON trip_operations; DROP FUNCTION test_order_time_rollback()',
    );
  }
  const results = await Promise.all(
    [0, 1].map(() => send('PUT', 'activities/order', { activity_ids }, key, expected)),
  );
  for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(results[0].body, results[1].body);
  const current = await get();
  assert.deepEqual(
    current.activities.map((a) => a.id),
    activity_ids,
  );
  const after = await before();
  for (const field of Object.keys(counts)) assert.equal(after[field], counts[field] + 1, field);
  for (const id of [seven.id, midnight.id]) {
    const activity = current.activities.find((a) => a.id === id);
    assert.equal(activity.starts_at, null);
    assert.equal(activity.ends_at, null);
    assert.equal(activity.scheduled_date, '2027-01-02');
  }
  for (const original of [eight, day, next, draft]) {
    const activity = current.activities.find((a) => a.id === original.id);
    for (const field of ['starts_at', 'ends_at', 'scheduled_date', 'title', 'selected_location_id'])
      assert.equal(activity[field], original[field], field);
  }
  const stillCompleted = current.activities.find((a) => a.id === seven.id);
  for (const field of ['status', 'completed_at', 'completed_by_user_id'])
    assert.equal(stillCompleted[field], completed[field]);
  const audit = (
    await query(
      'trip',
      `SELECT details FROM trip_audit_logs
    WHERE trip_id=$1 AND action='ACTIVITIES_REORDERED'`,
      [trip.id],
    )
  )[0];
  assert.deepEqual(
    new Set(audit.details.cleared_time_activity_ids),
    new Set([seven.id, midnight.id]),
  );
  const event = (
    await query('trip', 'SELECT payload FROM outbox_events WHERE operation_id=$1', [key])
  )[0];
  for (const id of [seven.id, midnight.id])
    assert(event.payload.changed_entities.some((e) => e.id === id && e.action === 'UPSERT'));
  const noOp = await send('PUT', 'activities/order', { activity_ids });
  assert.equal(noOp.status, 200);
  assert.deepEqual(await get(), current);
  assert.deepEqual(await before(), { ...after, receipts: after.receipts + 1 });
  const stale = await send(
    'PUT',
    'activities/order',
    { activity_ids: activity_ids.toReversed() },
    randomUUID(),
    expected,
  );
  assert.equal(stale.status, 409);
  assert.deepEqual(await get(), current);
  await send('PATCH', `activities/${next.id}`, { title: 'Later independent edit' });
  const latest = await get();
  const replay = await send('PUT', 'activities/order', { activity_ids }, key, expected);
  assert.deepEqual(replay.body, results[0].body);
  assert.deepEqual(await get(), latest);
  pass(
    'Reorder clears backwards 8h/7h and midnight times on the original Trip-local day; overnight, other days, day-only, unscheduled and completion data survive',
  );
  pass(
    'Order + time clearing rolls back together; concurrent replay emits one revision/audit/outbox, stale writes fail, no-op and historical replay preserve current state',
  );
}
