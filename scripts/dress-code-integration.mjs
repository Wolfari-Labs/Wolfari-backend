import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Calendar day of an instant in the Trip timezone, shifted by whole days. */
function localDate(instant, timezone, addDays = 0) {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(instant))
    .split('-')
    .map(Number);
  return new Date(Date.UTC(year, month - 1, day + addDays)).toISOString().slice(0, 10);
}

/** FR-PL03 / API050-053 through Gateway, Trip service and PostgreSQL. */
export async function runDressCodeScenarios({ request, query, bearer, tripBody, pass, users }) {
  const { owner, member, outsider } = users;
  const created = await request('/api/v1/trips', 'POST', tripBody('Dress codes'), bearer(owner));
  assert.equal(created.status, 201);
  const trip = created.body.data,
    root = `/api/v1/trips/${trip.id}`;
  let version = trip.plan_version;
  await query(
    'trip',
    `INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())`,
    [trip.id, member.id],
  );
  const assertStatus = (response, status) =>
    assert.equal(response.status, status, JSON.stringify(response.body));
  async function send(method, suffix, body, user = owner, key = randomUUID(), expected = version) {
    const result = await request(
      `${root}/${suffix}`,
      method,
      { expected_plan_version: expected, ...body },
      { ...bearer(user), 'idempotency-key': key, 'x-correlation-id': key },
    );
    if (result.status < 300) version = result.body.data.plan_version;
    return result;
  }
  const plan = async (user = owner) =>
    (await request(`${root}/plan`, 'GET', undefined, bearer(user))).body.data;
  const counts = async () =>
    (
      await query(
        'trip',
        `SELECT
    (SELECT count(*)::int FROM dress_codes WHERE trip_id=$1) AS dress_codes,
    (SELECT count(*)::int FROM trip_audit_logs WHERE trip_id=$1) AS audits,
    (SELECT count(*)::int FROM outbox_events WHERE trip_id=$1) AS events,
    (SELECT count(*)::int FROM trip_operations WHERE trip_id=$1) AS receipts,
    plan_version,export_revision FROM trips WHERE id=$1`,
        [trip.id],
      )
    )[0];
  const firstDay = localDate(trip.start_at, trip.timezone);

  assert.deepEqual((await plan()).capabilities, { dress_codes_write: true });
  const activity = (
    await send('POST', 'activities', { title: 'Temple', activity_type: 'OTHER', position: 0 })
  ).body.data;
  const before = await counts(),
    key = randomUUID();
  const day = await send(
    'POST',
    'dress-codes',
    {
      scope_type: 'DAY',
      plan_date: firstDay,
      activity_id: null,
      label: '  Beachwear ',
      description: ' ',
      public_description: 'Light clothes',
    },
    owner,
    key,
  );
  assertStatus(day, 201);
  assert.deepEqual(
    { ...day.body.data, id: null },
    {
      id: null,
      trip_id: trip.id,
      scope_type: 'DAY',
      plan_date: firstDay,
      activity_id: null,
      label: 'Beachwear',
      description: null,
      public_description: 'Light clothes',
      source: 'MANUAL',
      plan_version: before.plan_version + 1,
    },
  );
  assert.equal(day.body.meta.export_revision, before.export_revision + 1);
  const after = await counts();
  for (const name of Object.keys(before)) assert.equal(after[name], before[name] + 1, name);
  const event = (
    await query('trip', 'SELECT payload FROM outbox_events WHERE operation_id=$1', [key])
  )[0];
  assert.deepEqual(event.payload.changed_entities, [
    { type: 'DRESS_CODE', id: day.body.data.id, action: 'UPSERT' },
  ]);
  const audit = (
    await query(
      'trip',
      `SELECT action,entity_type,entity_id,from_version,to_version FROM trip_audit_logs
       WHERE trip_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1`,
      [trip.id],
    )
  )[0];
  assert.deepEqual(audit, {
    action: 'DRESS_CODE_CREATED',
    entity_type: 'DRESS_CODE',
    entity_id: day.body.data.id,
    from_version: before.plan_version,
    to_version: after.plan_version,
  });
  const replay = await send(
    'POST',
    'dress-codes',
    {
      scope_type: 'DAY',
      plan_date: firstDay,
      activity_id: null,
      label: '  Beachwear ',
      description: ' ',
      public_description: 'Light clothes',
    },
    owner,
    key,
    before.plan_version,
  );
  assertStatus(replay, 201);
  assert.deepEqual(replay.body.data, day.body.data);
  assert.deepEqual(await counts(), after);
  assertStatus(
    await send('POST', 'dress-codes', { scope_type: 'TRIP', label: 'Other body' }, owner, key),
    409,
  );
  pass(
    'Dress code create: one revision, audit, PlanUpdated and receipt; same-key replay is stable',
  );

  const whole = await send('POST', 'dress-codes', { scope_type: 'TRIP', label: 'Comfortable' });
  assertStatus(whole, 201);
  const forActivity = await send('POST', 'dress-codes', {
    scope_type: 'ACTIVITY',
    activity_id: activity.id,
    label: 'Covered shoulders',
  });
  assertStatus(forActivity, 201);
  const listed = await request(`${root}/dress-codes`, 'GET', undefined, bearer(member));
  assertStatus(listed, 200);
  assert.equal(listed.body.data.next_cursor, null);
  assert.deepEqual(
    listed.body.data.items.map((item) => item.scope_type),
    ['TRIP', 'DAY', 'ACTIVITY'],
  );
  assert.deepEqual(listed.body.data.items, (await plan(member)).dress_codes);
  assertStatus(await request(`${root}/dress-codes`, 'GET', undefined, bearer(outsider)), 404);
  assertStatus(await request(`${root}/dress-codes?limit=1`, 'GET', undefined, bearer(owner)), 400);
  pass('Dress code list: members read all three scopes in Plan order; outsiders see nothing');

  const foreign = (await request('/api/v1/trips', 'POST', tripBody('Dress foreign'), bearer(owner)))
    .body.data;
  const foreignActivity = (
    await request(
      `/api/v1/trips/${foreign.id}/activities`,
      'POST',
      { title: 'Elsewhere', activity_type: 'OTHER', position: 0, expected_plan_version: 1 },
      { ...bearer(owner), 'idempotency-key': randomUUID() },
    )
  ).body.data;
  const stable = await counts();
  for (const body of [
    { scope_type: 'DAY', plan_date: localDate(trip.start_at, trip.timezone, -1), label: 'Before' },
    { scope_type: 'DAY', plan_date: localDate(trip.end_at, trip.timezone, 2), label: 'After' },
    { scope_type: 'DAY', label: 'No date' },
    { scope_type: 'DAY', plan_date: firstDay, activity_id: activity.id, label: 'Two scopes' },
    { scope_type: 'TRIP', plan_date: firstDay, label: 'Trip with date' },
    { scope_type: 'ACTIVITY', activity_id: foreignActivity.id, label: 'Other trip' },
    { scope_type: 'ACTIVITY', activity_id: randomUUID(), label: 'Missing activity' },
    { scope_type: 'WEEK', label: 'Unknown scope' },
    { scope_type: 'TRIP', label: '' },
    { scope_type: 'TRIP', label: 'x'.repeat(101) },
    { scope_type: 'TRIP', label: 'Source', source: 'DSS' },
  ])
    assertStatus(await send('POST', 'dress-codes', body), 400);
  const stale = await send(
    'POST',
    'dress-codes',
    { scope_type: 'TRIP', label: 'Stale' },
    owner,
    randomUUID(),
    1,
  );
  assertStatus(stale, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.equal(stale.body.error.details.plan_version, version);
  for (const [method, suffix, body] of [
    ['POST', 'dress-codes', { scope_type: 'TRIP', label: 'Denied' }],
    ['PATCH', `dress-codes/${day.body.data.id}`, { label: 'Denied' }],
    ['DELETE', `dress-codes/${day.body.data.id}`, {}],
  ])
    assertStatus(await send(method, suffix, body, member), 403);
  assertStatus(
    await send('PATCH', `dress-codes/${day.body.data.id}`, { label: 'Hidden' }, outsider),
    404,
  );
  assert.deepEqual(await counts(), stable);
  pass(
    'Dress code validation: scope shape, Trip days, same-Trip activity, version and Editor checks write nothing',
  );

  assertStatus(await send('PATCH', `dress-codes/${day.body.data.id}`, { scope_type: 'TRIP' }), 400);
  assertStatus(await send('PATCH', `dress-codes/${day.body.data.id}`, {}), 400);
  const unchanged = await send('PATCH', `dress-codes/${day.body.data.id}`, { label: 'Beachwear' });
  assertStatus(unchanged, 200);
  assert.equal(unchanged.body.data.plan_version, stable.plan_version);
  const moved = await send('PATCH', `dress-codes/${day.body.data.id}`, {
    scope_type: 'ACTIVITY',
    plan_date: null,
    activity_id: activity.id,
    label: 'Modest',
    public_description: null,
  });
  assertStatus(moved, 200);
  assert.deepEqual(
    [moved.body.data.scope_type, moved.body.data.plan_date, moved.body.data.activity_id],
    ['ACTIVITY', null, activity.id],
  );
  assert.equal(moved.body.data.public_description, null);
  assert.equal(moved.body.data.plan_version, stable.plan_version + 1);
  await query('trip', `UPDATE dress_codes SET source='DSS' WHERE id=$1`, [whole.body.data.id]);
  const edited = await send('PATCH', `dress-codes/${whole.body.data.id}`, {
    description: 'Edited by hand',
  });
  assertStatus(edited, 200);
  assert.equal(edited.body.data.source, 'DSS');
  assertStatus(await send('PATCH', `dress-codes/${randomUUID()}`, { label: 'Missing' }), 404);
  assertStatus(
    await request(
      `/api/v1/trips/${foreign.id}/dress-codes/${whole.body.data.id}`,
      'PATCH',
      { expected_plan_version: 2, label: 'Cross trip' },
      { ...bearer(owner), 'idempotency-key': randomUUID() },
    ),
    404,
  );
  pass(
    'Dress code update: merged scope validation, explicit clears, unchanged PATCH keeps the version',
  );

  const deleteKey = randomUUID(),
    beforeDelete = await counts();
  const removed = await send('DELETE', `dress-codes/${whole.body.data.id}`, {}, owner, deleteKey);
  assertStatus(removed, 200);
  assert.deepEqual(removed.body.data, {
    trip_id: trip.id,
    plan_version: beforeDelete.plan_version + 1,
    export_revision: beforeDelete.export_revision + 1,
  });
  const tombstone = (
    await query('trip', 'SELECT payload FROM outbox_events WHERE operation_id=$1', [deleteKey])
  )[0];
  assert.deepEqual(tombstone.payload.tombstones, [
    { type: 'DRESS_CODE', id: whole.body.data.id, source_version: version },
  ]);
  const again = await send(
    'DELETE',
    `dress-codes/${whole.body.data.id}`,
    {},
    owner,
    deleteKey,
    beforeDelete.plan_version,
  );
  assertStatus(again, 200);
  assert.deepEqual(again.body.data, removed.body.data);
  assertStatus(await send('DELETE', `dress-codes/${whole.body.data.id}`, {}), 404);
  assertStatus(await send('DELETE', `dress-codes/${moved.body.data.id}`, { confirmed: true }), 400);
  // FR-PL01: deleting an Activity removes the dress codes scoped to it.
  assertStatus(await send('DELETE', `activities/${activity.id}`, { confirmed: true }), 200);
  assert.deepEqual((await plan()).dress_codes, []);
  pass('Dress code delete: tombstone event, replay after deletion, cascade with its Activity');

  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [trip.id]);
  const archived = await send('POST', 'dress-codes', { scope_type: 'TRIP', label: 'Archived' });
  assertStatus(archived, 409);
  assert.equal(archived.body.error.code, 'STATE_CONFLICT');
  pass('Dress code writes are rejected on an archived Trip');
}
