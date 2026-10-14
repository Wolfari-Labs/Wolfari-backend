import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseEventForPublish } = require('../packages/contracts/dist/events.js');

export async function runPlanScenarios({
  request,
  query,
  transaction,
  account,
  bearer,
  tripBody,
  pass,
  users,
}) {
  const owner = users?.owner ?? (await account('Plan Owner')),
    member = users?.member ?? (await account('Plan Member'));
  const editor = users?.editor ?? (await account('Plan Editor')),
    outsider = users?.outsider ?? (await account('Plan Outsider'));
  const created = await request(
    '/api/v1/trips',
    'POST',
    tripBody('Planning timeline'),
    bearer(owner),
  );
  assert.equal(created.status, 201);
  const trip = created.body.data,
    root = `/api/v1/trips/${trip.id}`;
  let version = trip.plan_version;
  for (const user of [member, editor])
    await query(
      'trip',
      `INSERT INTO trip_members(trip_id,user_id,role,joined_at)
    VALUES($1,$2,'MEMBER',now())`,
      [trip.id, user.id],
    );
  const membership = (user) =>
    query(
      'trip',
      'SELECT id FROM trip_members WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL',
      [trip.id, user.id],
    );
  const get = async (user = owner) => request(`${root}/plan`, 'GET', undefined, bearer(user));
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
  const counts = async () =>
    (
      await query(
        'trip',
        `SELECT
    (SELECT count(*)::int FROM activities WHERE trip_id=$1) AS activities,
    (SELECT count(*)::int FROM trip_audit_logs WHERE trip_id=$1) AS audits,
    (SELECT count(*)::int FROM outbox_events WHERE trip_id=$1) AS events,
    (SELECT count(*)::int FROM trip_operations WHERE trip_id=$1) AS receipts,
    plan_version,export_revision FROM trips WHERE id=$1`,
        [trip.id],
      )
    )[0];
  const assertStatus = (response, status) =>
    assert.equal(response.status, status, JSON.stringify(response.body));
  const start = Date.parse(trip.start_at),
    end = Date.parse(trip.end_at);
  const date = trip.start_at.slice(0, 10);
  const locationId = randomUUID(),
    dayDress = randomUUID(),
    tripDress = randomUUID();
  await query(
    'trip',
    `INSERT INTO selected_locations(id,trip_id,name,latitude,longitude,metadata,created_by_user_id)
    VALUES($1,$2,'Lake',16.123456,108.123456,'{"private_token":"never expose"}'::jsonb,$3)`,
    [locationId, trip.id, owner.id],
  );
  await query(
    'trip',
    `INSERT INTO dress_codes(id,trip_id,scope_type,plan_date,label,created_by_user_id)
    VALUES($1,$2,'DAY',$3,'Blue',$4),($5,$2,'TRIP',NULL,'Comfortable',$4)`,
    [dayDress, trip.id, date, owner.id, tripDress],
  );
  await query(
    'trip',
    `INSERT INTO packing_items(trip_id,name,quantity,created_by_user_id) VALUES($1,'Water',2.50,$2)`,
    [trip.id, owner.id],
  );
  const initial = await get();
  assertStatus(initial, 200);
  assert.deepEqual(initial.body.data.permissions, {
    can_read: true,
    can_edit: true,
    can_complete: true,
  });
  assert.deepEqual(initial.body.data.activities, []);
  assert.deepEqual(initial.body.data.selected_locations[0].metadata, {});
  assert.equal(initial.body.data.selected_locations[0].latitude, '16.123456');
  assert.equal(initial.body.data.packing_items[0].quantity, '2.50');
  assert.deepEqual(
    initial.body.data.dress_codes.map((x) => x.scope_type),
    ['TRIP', 'DAY'],
  );
  assert.equal(initial.body.data.dress_codes[1].plan_date, date);
  assert.equal((await get(member)).body.data.permissions.can_edit, false);
  assertStatus(await get(outsider), 404);
  pass(
    'Plan snapshot: membership, permissions, all four lists, timezone-safe date and exact decimals',
  );

  const activities = [];
  for (const [title, position] of [
    ['A', 0],
    ['B', 1],
    ['C', 0],
  ]) {
    const before = await counts(),
      key = randomUUID();
    const result = await send(
      'POST',
      'activities',
      { title, activity_type: 'OTHER', position },
      owner,
      key,
    );
    assertStatus(result, 201);
    activities.push(result.body.data);
    const after = await counts();
    for (const name of [
      'activities',
      'audits',
      'events',
      'receipts',
      'plan_version',
      'export_revision',
    ])
      assert.equal(after[name], before[name] + 1, name);
    const event = (
      await query('trip', 'SELECT * FROM outbox_events WHERE operation_id=$1', [key])
    )[0];
    parseEventForPublish(
      Object.fromEntries(
        [
          'event_id',
          'event_type',
          'schema_version',
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
        ]
          .map((name) => [name, event[name]])
          .concat([['occurred_at', event.occurred_at.toISOString()]]),
      ),
    );
    assert.equal(event.status, 'PENDING');
    assert.equal(event.payload.source_version, after.plan_version);
  }
  const [a, b, c] = activities;
  let snapshot = (await get()).body.data;
  assert.deepEqual(
    snapshot.activities.map((x) => x.id),
    [c.id, a.id, b.id],
  );
  assert.deepEqual(
    snapshot.activities.map((x) => x.position),
    [0, 1, 2],
  );
  assert(snapshot.activities.every((x) => x.plan_version === version));
  pass(
    'Plan create inserts at requested position and atomically records one revision, audit, event and receipt',
  );

  const foreignTrip = (
    await request('/api/v1/trips', 'POST', tripBody('Other Plan'), bearer(owner))
  ).body.data;
  const foreignLocation = (
    await query(
      'trip',
      `INSERT INTO selected_locations(trip_id,name,created_by_user_id)
    VALUES($1,'Other place',$2) RETURNING id`,
      [foreignTrip.id, owner.id],
    )
  )[0].id;
  const beforeInvalid = await counts();
  for (const bad of [
    { starts_at: new Date(start - 1).toISOString(), ends_at: new Date(end).toISOString() },
    { starts_at: trip.start_at },
    { position: 99 },
    { selected_location_id: foreignLocation },
    { unknown_field: true },
    { status: 'COMPLETED' },
  ])
    assertStatus(
      await send('POST', 'activities', {
        title: 'Invalid',
        activity_type: 'OTHER',
        position: 0,
        ...bad,
      }),
      400,
    );
  assertStatus(
    await request(
      `${root}/activities`,
      'POST',
      { title: 'Missing key', activity_type: 'OTHER', position: 0, expected_plan_version: version },
      bearer(owner),
    ),
    400,
  );
  assertStatus(await send('PATCH', `activities/${a.id}`, { status: 'COMPLETED' }), 400);
  assertStatus(
    await send('PATCH', `activities/${a.id}/completion`, {
      status: 'COMPLETED',
      title: 'Forbidden',
    }),
    400,
  );
  assertStatus(await send('PUT', 'activities/order', { activity_ids: [a.id, a.id, b.id] }), 400);
  assertStatus(await send('PUT', 'activities/order', { activity_ids: [a.id] }), 400);
  assert.deepEqual(await counts(), beforeInvalid);
  const stale = await send(
    'PATCH',
    `activities/${a.id}`,
    { title: 'Stale' },
    owner,
    randomUUID(),
    version - 1,
  );
  assertStatus(stale, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(stale.body.error.details, {
    plan_version: version,
    export_revision: beforeInvalid.export_revision,
  });
  assertStatus(
    await send('PATCH', `activities/${a.id}`, {
      starts_at: trip.start_at,
      ends_at: trip.end_at,
      selected_location_id: locationId,
    }),
    200,
  );
  const partial = await send('PATCH', `activities/${a.id}`, {
    ends_at: new Date(end - 1000).toISOString(),
  });
  assertStatus(partial, 200);
  assert.equal(partial.body.data.starts_at, trip.start_at);
  assertStatus(await send('PATCH', `activities/${a.id}`, { starts_at: null }), 400);
  assertStatus(await send('PATCH', `activities/${a.id}`, { starts_at: null, ends_at: null }), 200);
  pass(
    'Plan validates writes, version details and merged partial timestamp PATCH before committing',
  );

  for (const [method, suffix, body] of [
    ['POST', 'activities', { title: 'Denied', activity_type: 'OTHER', position: 0 }],
    ['PATCH', `activities/${a.id}`, { title: 'Denied' }],
    ['DELETE', `activities/${a.id}`, { confirmed: true }],
    ['PUT', 'activities/order', { activity_ids: [a.id, b.id, c.id] }],
  ])
    assertStatus(await send(method, suffix, body, member), 403);
  let done = await send('PATCH', `activities/${a.id}/completion`, { status: 'COMPLETED' }, member);
  assertStatus(done, 200);
  assert.equal(done.body.data.completed_by_user_id, member.id);
  assert(done.body.data.completed_at);
  const beforeNoop = await counts();
  const duplicate = await send(
    'PATCH',
    `activities/${a.id}/completion`,
    { status: 'COMPLETED' },
    owner,
  );
  assertStatus(duplicate, 200);
  assert.equal(duplicate.body.data.completed_by_user_id, member.id);
  assert.equal(duplicate.body.data.completed_at, done.body.data.completed_at);
  assert.deepEqual(await counts(), { ...beforeNoop, receipts: beforeNoop.receipts + 1 });
  assertStatus(
    await send('PATCH', `activities/${a.id}/completion`, { status: 'TODO' }, editor),
    403,
  );
  assertStatus(
    await send('PATCH', `activities/${a.id}/completion`, { status: 'TODO' }, member),
    200,
  );
  done = await send('PATCH', `activities/${a.id}/completion`, { status: 'COMPLETED' }, owner);
  assertStatus(done, 200);
  assertStatus(
    await send('PATCH', `activities/${a.id}/completion`, { status: 'TODO' }, member),
    403,
  );
  assertStatus(
    await send('PATCH', `activities/${a.id}/completion`, { status: 'TODO' }, owner),
    200,
  );
  pass(
    'AT02: ordinary member completion, author/Owner reopening and completed no-op retain original attribution',
  );

  await query('trip', "UPDATE trips SET plan_edit_policy='ALL_MEMBERS' WHERE id=$1", [trip.id]);
  const byMember = await send(
    'POST',
    'activities',
    { title: 'Member activity', activity_type: 'OTHER', position: 3 },
    member,
  );
  assertStatus(byMember, 201);
  await query('trip', "UPDATE trips SET plan_edit_policy='SELECTED_MEMBERS' WHERE id=$1", [
    trip.id,
  ]);
  const editBody = { title: 'Selected editor' },
    editKey = randomUUID();
  assertStatus(await send('PATCH', `activities/${a.id}`, editBody, editor), 403);
  const editorMembership = (await membership(editor))[0].id;
  await query(
    'trip',
    'INSERT INTO trip_plan_editors(trip_id,trip_member_id,granted_by_user_id) VALUES($1,$2,$3)',
    [trip.id, editorMembership, owner.id],
  );
  assert.equal((await get(editor)).body.data.permissions.can_edit, true);
  const editVersion = version;
  const editResult = await send(
    'PATCH',
    `activities/${a.id}`,
    editBody,
    editor,
    editKey,
    editVersion,
  );
  assertStatus(editResult, 200);
  await send('PATCH', `activities/${a.id}/completion`, { status: 'COMPLETED' }, owner);
  assertStatus(
    await send('PATCH', `activities/${a.id}/completion`, { status: 'TODO' }, editor),
    200,
  );
  let racingEdit;
  const beforeRevocation = await counts();
  await transaction('trip', async (client) => {
    await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [trip.id]);
    const holder = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    racingEdit = send('PATCH', `activities/${a.id}`, { title: 'Revocation race' }, editor);
    // Wait until the request is actually blocked on our lock, rather than relying on timing.
    const deadline = Date.now() + 1000;
    let waiting = false;
    while (Date.now() < deadline) {
      const blocked = await query(
        'trip',
        'SELECT pid FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))',
        [holder],
      );
      if (blocked.length) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(waiting, 'Plan write must be waiting for the Trip lock');
    await client.query('DELETE FROM trip_plan_editors WHERE trip_id=$1 AND trip_member_id=$2', [
      trip.id,
      editorMembership,
    ]);
  });
  assertStatus(await racingEdit, 403);
  assert.deepEqual(await counts(), beforeRevocation);
  pass(
    'AT03: an edit waiting on Trip lock sees editor revocation committed before lock acquisition',
  );
  assertStatus(
    await send('PATCH', `activities/${a.id}`, editBody, editor, editKey, editVersion),
    403,
  );
  await query(
    'trip',
    'INSERT INTO trip_plan_editors(trip_id,trip_member_id,granted_by_user_id) VALUES($1,$2,$3)',
    [trip.id, editorMembership, owner.id],
  );
  await transaction('trip', async (client) => {
    await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [trip.id]);
    await client.query("UPDATE trip_members SET left_at=now(),left_reason='TEST' WHERE id=$1", [
      editorMembership,
    ]);
    await client.query(
      "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
      [trip.id, editor.id],
    );
  });
  assertStatus(await send('PATCH', `activities/${a.id}`, { title: 'Rejoined' }, editor), 403);
  pass(
    'All three Plan policies, selected-editor reopening, revoked replay and fresh membership on rejoin',
  );

  const replayKey = randomUUID(),
    replayVersion = version;
  const replayBody = { title: 'Saved outcome' };
  const beforeReplay = await counts();
  const replayed = await Promise.all(
    [0, 1].map(() =>
      send('PATCH', `activities/${a.id}`, replayBody, owner, replayKey, replayVersion),
    ),
  );
  replayed.forEach((result) => assertStatus(result, 200));
  assert.deepEqual(replayed[0].body, replayed[1].body);
  const afterReplay = await counts();
  for (const name of ['audits', 'events', 'receipts', 'plan_version', 'export_revision'])
    assert.equal(afterReplay[name], beforeReplay[name] + 1);
  await send('PATCH', `activities/${a.id}`, { title: 'Current outcome' });
  const currentVersion = version;
  assert.deepEqual(
    (await send('PATCH', `activities/${a.id}`, replayBody, owner, replayKey, replayVersion)).body,
    replayed[0].body,
  );
  version = currentVersion;
  assertStatus(
    await send(
      'PATCH',
      `activities/${a.id}`,
      { title: 'Conflicting body' },
      owner,
      replayKey,
      replayVersion,
    ),
    409,
  );
  const noOpBefore = await counts();
  assertStatus(await send('PATCH', `activities/${a.id}`, { title: 'Current outcome' }), 200);
  assert.deepEqual(await counts(), { ...noOpBefore, receipts: noOpBefore.receipts + 1 });
  pass(
    'Idempotency: concurrent and historical replay preserve saved outcome; no-op writes only a receipt',
  );

  snapshot = (await get()).body.data;
  const ids = snapshot.activities.map((x) => x.id),
    concurrentVersion = version;
  const orders = [ids.toReversed(), [...ids.slice(1), ids[0]]];
  const orderResults = await Promise.all(
    orders.map((activity_ids) =>
      send('PUT', 'activities/order', { activity_ids }, owner, randomUUID(), concurrentVersion),
    ),
  );
  assert.deepEqual(orderResults.map((x) => x.status).sort(), [200, 409]);
  const winner = orderResults.findIndex((x) => x.status === 200);
  snapshot = (await get()).body.data;
  version = snapshot.plan_version;
  assert.deepEqual(
    snapshot.activities.map((x) => x.id),
    orders[winner],
  );
  assert.deepEqual(
    snapshot.activities.map((x) => x.position),
    ids.map((_, i) => i),
  );
  const orderBefore = await counts();
  assertStatus(await send('PUT', 'activities/order', { activity_ids: orders[winner] }), 200);
  assert.deepEqual(await counts(), { ...orderBefore, receipts: orderBefore.receipts + 1 });
  pass(
    'AC-PL01: competing reorders have one winner, contiguous positions, and an unchanged-order no-op',
  );

  const activityDress = randomUUID();
  await query(
    'trip',
    `INSERT INTO dress_codes(id,trip_id,scope_type,activity_id,label,created_by_user_id)
    VALUES($1,$2,'ACTIVITY',$3,'Hiking',$4)`,
    [activityDress, trip.id, a.id, owner.id],
  );
  assertStatus(await send('DELETE', `activities/${a.id}`, { confirmed: false }), 400);
  const deleteKey = randomUUID();
  assertStatus(
    await send('DELETE', `activities/${a.id}`, { confirmed: true }, owner, deleteKey),
    200,
  );
  snapshot = (await get()).body.data;
  assert(!snapshot.activities.some((x) => x.id === a.id));
  assert(snapshot.selected_locations.some((x) => x.id === locationId));
  assert.deepEqual(
    snapshot.dress_codes.map((x) => x.id),
    [tripDress, dayDress],
  );
  assert.deepEqual(
    snapshot.activities.map((x) => x.position),
    snapshot.activities.map((_, i) => i),
  );
  const deletion = (
    await query('trip', 'SELECT payload FROM outbox_events WHERE operation_id=$1', [deleteKey])
  )[0].payload;
  assert.deepEqual(new Set(deletion.tombstones.map((x) => x.id)), new Set([a.id, activityDress]));
  const audit = (
    await query(
      'trip',
      "SELECT actor_user_id,details FROM trip_audit_logs WHERE trip_id=$1 AND action='ACTIVITY_DELETED'",
      [trip.id],
    )
  )[0];
  assert.equal(audit.actor_user_id, owner.id);
  assert.equal(audit.details.activity.title, 'Current outcome');
  assert.deepEqual(audit.details.deleted_dress_code_ids, [activityDress]);
  pass(
    'Delete cascades only activity dress codes, compacts positions and retains audit plus tombstones',
  );

  for (const table of ['trip_audit_logs', 'outbox_events', 'trip_operations']) {
    const before = await counts(),
      key = randomUUID(),
      expected = version;
    const body = { title: `Rollback ${table}`, activity_type: 'OTHER', position: 0 };
    const trigger = `test_fail_plan_${table}`;
    await query(
      'trip',
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional Plan rollback'; END $$;
      CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      assertStatus(await send('POST', 'activities', body, owner, key, expected), 503);
      assert.deepEqual(await counts(), before);
    } finally {
      await query('trip', `DROP TRIGGER ${trigger} ON ${table}; DROP FUNCTION ${trigger}()`);
    }
    assertStatus(await send('POST', 'activities', body, owner, key, expected), 201);
  }
  pass(
    'Audit, outbox and receipt insertion failures each roll back all Plan changes; same-key retry succeeds',
  );

  const beforeOverflow = await counts();
  for (const column of ['plan_version', 'export_revision']) {
    await query('trip', `UPDATE trips SET ${column}=2147483647 WHERE id=$1`, [trip.id]);
    const expected = column === 'plan_version' ? 2147483647 : version;
    const overflow = await send(
      'PATCH',
      `activities/${b.id}`,
      { title: 'Overflow' },
      owner,
      randomUUID(),
      expected,
    );
    assertStatus(overflow, 409);
    assert.equal(overflow.body.error.code, 'STATE_CONFLICT');
    await query('trip', `UPDATE trips SET ${column}=$2 WHERE id=$1`, [
      trip.id,
      beforeOverflow[column],
    ]);
    assert.deepEqual(await counts(), beforeOverflow);
  }
  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [trip.id]);
  const archived = await get();
  assertStatus(archived, 200);
  assert.deepEqual(archived.body.data.permissions, {
    can_read: true,
    can_edit: false,
    can_complete: false,
  });
  for (const [suffix, body] of [
    [`activities/${b.id}`, { title: 'Archived' }],
    [`activities/${b.id}/completion`, { status: 'COMPLETED' }],
  ]) {
    const result = await send('PATCH', suffix, body);
    assertStatus(result, 409);
    assert.equal(result.body.error.code, 'STATE_CONFLICT');
  }
  await query('trip', 'UPDATE trips SET deleted_at=now() WHERE id=$1', [trip.id]);
  assertStatus(await get(), 404);
  pass('Plan revision overflow rolls back; archive is read-only and deleted Trips are hidden');

  const empty = await request(
    `/api/v1/trips/${foreignTrip.id}/activities/order`,
    'PUT',
    { expected_plan_version: 1, activity_ids: [] },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assertStatus(empty, 200);
  assert.equal(empty.body.data.plan_version, 1);
  pass('Empty Plan accepts an empty reorder without changing its version');
}
