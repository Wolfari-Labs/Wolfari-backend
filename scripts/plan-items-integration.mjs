import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Runs inside trip:test's isolated PostgreSQL/Gateway harness, never a developer database. */
export async function runPlanItemScenarios({
  request,
  query,
  owner,
  member,
  outsider,
  bearer,
  tripBody,
  pass,
}) {
  const created = await request(
    '/api/v1/trips',
    'POST',
    tripBody('Shared packing and dress codes'),
    bearer(owner),
  );
  assert.equal(created.status, 201);
  const trip = created.body.data,
    root = `/api/v1/trips/${trip.id}`;
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
    [trip.id, member.id],
  );
  const membership = (
    await query('trip', 'SELECT id FROM trip_members WHERE trip_id=$1 AND user_id=$2', [
      trip.id,
      member.id,
    ])
  )[0].id;
  let version = trip.plan_version;
  const send = async (
    method,
    suffix,
    fields,
    actor = owner,
    key = randomUUID(),
    expected = version,
  ) => {
    const result = await request(
      `${root}/${suffix}`,
      method,
      { ...fields, expected_plan_version: expected },
      { ...bearer(actor), 'idempotency-key': key },
    );
    if (result.status < 300) version = result.body.data.plan_version;
    return result;
  };
  const get = async () =>
    (await request(`${root}/plan`, 'GET', undefined, bearer(owner))).body.data;
  const before = await get();
  assert.equal(before.capabilities.packing_write, true);
  assert.equal(before.capabilities.dress_codes_write, true);
  assert.equal(before.capabilities.locations_write, true);
  const locationFields = { name: 'Bãi biển Mỹ Khê', address: 'Đà Nẵng', latitude: '16.050000', longitude: '108.240000', attribution: [{ text: 'Geoapify', url: 'https://www.geoapify.com/' }] };
  assert.equal((await send('POST', 'selected-locations', locationFields, member)).status, 403);
  assert.equal((await send('POST', 'selected-locations', locationFields, outsider)).status, 404);
  assert.equal((await send('POST', 'selected-locations', { ...locationFields, latitude: '91' })).status, 400);
  assert.equal((await send('POST', 'selected-locations', { ...locationFields, longitude: null })).status, 400);
  const locationKey = randomUUID(), locationVersion = version;
  const location = await send('POST', 'selected-locations', locationFields, owner, locationKey);
  assert.equal(location.status, 201, JSON.stringify(location.body));
  const savedLocation = location.body.data;
  assert.deepEqual((await send('POST', 'selected-locations', locationFields, owner, locationKey, locationVersion)).body.data, savedLocation);
  assert.equal((await get()).selected_locations.length, 1);
  assert.deepEqual((await get()).selected_locations[0].metadata.attribution, locationFields.attribution);
  assert.equal((await send('PATCH', `selected-locations/${savedLocation.id}`, { name: 'Tên cũ' }, owner, randomUUID(), locationVersion)).status, 409);
  const linked = await send('POST', 'activities', { title: 'Đi dạo', activity_type: 'OTHER', starts_at: null, ends_at: null, scheduled_date: null, selected_location_id: savedLocation.id, position: 0 });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal((await send('DELETE', `selected-locations/${savedLocation.id}`, {})).status, 409);
  assert.equal((await send('DELETE', `activities/${linked.body.data.id}`, { confirmed: true })).status, 200);
  const key = randomUUID(),
    startVersion = version;
  const fields = { name: 'Nước uống', quantity: '1.25', assigned_member_id: membership };
  const first = await send('POST', 'packing-items', fields, owner, key, startVersion);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.quantity, '1.25');
  const item = first.body.data;
  const replay = await send('POST', 'packing-items', fields, owner, key, startVersion);
  assert.equal(replay.body.data.id, item.id);
  assert.equal((await get()).packing_items.length, 1);
  assert.equal(
    (
      await send(
        'POST',
        'packing-items',
        { ...fields, name: 'Different' },
        owner,
        key,
        startVersion,
      )
    ).status,
    409,
  );
  assert.equal((await send('POST', 'packing-items', fields, member)).status, 403);
  assert.equal(
    (await send('PATCH', `packing-items/${item.id}`, { name: 'X' }, outsider)).status,
    404,
  );
  assert.equal(
    (
      await send(
        'PATCH',
        `packing-items/${item.id}`,
        { name: 'X' },
        owner,
        randomUUID(),
        startVersion,
      )
    ).status,
    409,
  );
  assert.equal(
    (await send('PATCH', `packing-items/${item.id}/completion`, { status: 'COMPLETED' }, member))
      .status,
    200,
  );
  assert.equal((await get()).packing_items[0].status, 'COMPLETED');
  const dress = await send('POST', 'dress-codes', {
    scope_type: 'TRIP',
    label: 'Trắng',
    description: 'Trang phục chung',
  });
  assert.equal(dress.status, 201);
  assert.equal(
    (await send('PATCH', `dress-codes/${dress.body.data.id}`, { label: 'Xanh' })).status,
    200,
  );
  assert.equal((await get()).dress_codes[0].label, 'Xanh');
  assert.equal(
    (
      await send('POST', 'dress-codes', {
        scope_type: 'DAY',
        plan_date: '1900-01-01',
        label: 'Invalid day',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await send('POST', 'packing-items', {
        name: 'Invalid member',
        assigned_member_id: randomUUID(),
      })
    ).status,
    400,
  );
  const counts = async () =>
    (
      await query(
        'trip',
        `SELECT
      (SELECT count(*)::int FROM trip_audit_logs WHERE trip_id=$1) AS audit,
      (SELECT count(*)::int FROM outbox_events WHERE trip_id=$1) AS outbox,
      (SELECT count(*)::int FROM trip_operations WHERE trip_id=$1) AS receipts`,
        [trip.id],
      )
    )[0];
  for (const [suffix, field] of [
    [`selected-locations/${savedLocation.id}`, 'name'],
    [`packing-items/${item.id}`, 'name'],
    [`dress-codes/${dress.body.data.id}`, 'label'],
  ]) {
    for (const table of ['trip_audit_logs', 'outbox_events', 'trip_operations']) {
      const snapshot = await get(),
        beforeCounts = await counts();
      const retryKey = randomUUID(),
        expected = version;
      const body = { [field]: `Rollback ${table}` };
      const trigger = `test_fail_item_${table}`;
      await query(
        'trip',
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'intentional item rollback'; END $$;
        CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      try {
        assert.equal((await send('PATCH', suffix, body, owner, retryKey, expected)).status, 503);
        assert.deepEqual(await get(), snapshot);
        assert.deepEqual(await counts(), beforeCounts);
      } finally {
        await query('trip', `DROP TRIGGER ${trigger} ON ${table}; DROP FUNCTION ${trigger}()`);
      }
      const recovered = await send('PATCH', suffix, body, owner, retryKey, expected);
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      const replayed = await send('PATCH', suffix, body, owner, retryKey, expected);
      assert.deepEqual(replayed.body.data, recovered.body.data);
    }
  }
  pass(
    'Location, packing and dress code writes roll back on audit/outbox/receipt failure and recover with the same key',
  );
  const events = await query(
    'trip',
    "SELECT payload FROM outbox_events WHERE trip_id=$1 AND event_type='PlanUpdated'",
    [trip.id],
  );
  assert.ok(
    events.some((row) =>
      row.payload.changed_entities.some((entity) => entity.type === 'PACKING_ITEM'),
    ),
  );
  assert.ok(
    events.some((row) =>
      row.payload.changed_entities.some((entity) => entity.type === 'DRESS_CODE'),
    ),
  );
  assert.equal((await send('DELETE', `selected-locations/${savedLocation.id}`, {})).status, 200);
  assert.equal((await get()).selected_locations.length, 0);
  assert.equal((await send('DELETE', `packing-items/${item.id}`, {})).status, 200);
  assert.equal((await send('DELETE', `dress-codes/${dress.body.data.id}`, {})).status, 200);
  const final = await get();
  assert.equal(final.packing_items.length, 0);
  assert.equal(final.dress_codes.length, 0);
  pass(
    'Shared Plan collections: CRUD, assignment/completion, idempotency, stale versions, access, audit/outbox and persisted reload',
  );
}
