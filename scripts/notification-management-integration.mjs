import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runNotificationManagementTests({
  request,
  query,
  account,
  bearer,
  tripBody,
  pass,
}) {
  const first = await account('Notification First User');
  const second = await account('Notification Second User');

  const defaults = await request(
    '/api/v1/me/notification-preferences',
    'GET',
    undefined,
    bearer(first),
  );
  assert.equal(defaults.status, 200);
  assert.deepEqual(defaults.body.data, {
    push_enabled: true,
    email_enabled: true,
    group_overrides: {},
    version: 1,
  });
  assert.equal(
    (
      await query(
        'automation',
        'SELECT count(*)::int AS n FROM notification_preferences WHERE user_id=$1',
        [first.id],
      )
    )[0].n,
    0,
  );
  pass('API126 returns read-only virtual defaults before the first preference write');

  const preferenceBodies = [
    {
      push_enabled: true,
      email_enabled: false,
      group_overrides: { PRICE: { push: false } },
      expected_version: 1,
    },
    {
      push_enabled: false,
      email_enabled: true,
      group_overrides: { INVITATION: { email: false } },
      expected_version: 1,
    },
  ];
  const concurrent = await Promise.all(
    preferenceBodies.map((body) =>
      request('/api/v1/me/notification-preferences', 'PUT', body, bearer(first)),
    ),
  );
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
  const current = await request(
    '/api/v1/me/notification-preferences',
    'GET',
    undefined,
    bearer(first),
  );
  assert.equal(current.body.data.version, 2);
  const replaced = await request(
    '/api/v1/me/notification-preferences',
    'PUT',
    {
      push_enabled: false,
      email_enabled: true,
      group_overrides: {
        INVITATION: { email: false },
        PRICE: { push: true, email: false },
      },
      expected_version: 2,
    },
    bearer(first),
  );
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.data.version, 3);
  assert.deepEqual(replaced.body.data.group_overrides, {
    INVITATION: { email: false },
    PRICE: { push: true, email: false },
  });
  const cleared = await request('/api/v1/me/notification-preferences', 'PUT', {
    push_enabled: true, email_enabled: true, group_overrides: {}, expected_version: 3,
  }, bearer(first));
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.version, 4);
  assert.deepEqual(cleared.body.data.group_overrides, {});
  assert.equal(
    (
      await request(
        '/api/v1/me/notification-preferences',
        'PUT',
        { ...preferenceBodies[0], expected_version: 2 },
        bearer(first),
      )
    ).status,
    409,
  );
  pass('API127 serializes the first write, replaces fixed groups and rejects stale versions');

  const token = `web-token-${randomUUID()}-${randomUUID()}`;
  const registered = await request(
    '/api/v1/me/devices',
    'POST',
    { platform: 'WEB', token },
    bearer(first),
  );
  assert.equal(registered.status, 200);
  assert.equal(registered.body.data.platform, 'WEB');
  assert.equal(JSON.stringify(registered.body).includes(token), false);
  const replay = await request(
    '/api/v1/me/devices',
    'POST',
    { platform: 'ANDROID', token },
    bearer(first),
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.id, registered.body.data.id);
  assert.equal(replay.body.data.platform, 'ANDROID');
  assert.equal(
    (await request('/api/v1/me/devices', 'POST', { platform: 'WEB', token }, bearer(second)))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        `/api/v1/me/devices/${registered.body.data.id}`,
        'DELETE',
        undefined,
        bearer(second),
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await query('automation', 'SELECT user_id FROM device_tokens WHERE id=$1', [
        registered.body.data.id,
      ])
    )[0].user_id,
    first.id,
  );
  assert.equal(
    (
      await request(
        `/api/v1/me/devices/${registered.body.data.id}`,
        'DELETE',
        undefined,
        bearer(first),
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await request(
        `/api/v1/me/devices/${registered.body.data.id}`,
        'DELETE',
        undefined,
        bearer(first),
      )
    ).status,
    204,
  );
  const reassigned = await request(
    '/api/v1/me/devices',
    'POST',
    { platform: 'WEB', token },
    bearer(second),
  );
  assert.equal(reassigned.status, 200);
  assert.notEqual(reassigned.body.data.id, registered.body.data.id);
  pass('API128/129 keep token ownership isolated, replay safely and unbind on Self delete');

  const createTrip = async (owner, name) => {
    const key = randomUUID();
    const response = await request('/api/v1/trips', 'POST', tripBody(name, key), {
      ...bearer(owner),
      'idempotency-key': key,
    });
    assert.equal(response.status, 201);
    return response.body.data.id;
  };
  const ownTrip = await createTrip(first, 'Notification owned Trip');
  const hiddenTrip = await createTrip(second, 'Notification hidden Trip');
  const ownId = randomUUID();
  const hiddenId = randomUUID();
  const globalId = randomUUID();
  const createdId = randomUUID();
  const otherId = randomUUID();
  await query(
    'automation',
    `INSERT INTO notifications(id,user_id,trip_id,type,title,body,source_id,status,dedupe_key,created_at)
     VALUES
       ($1,$2,$3,'PRICE_ALERT','Own title','Own private body','own-source','AVAILABLE',($1::uuid)::text,clock_timestamp()-interval '3 minutes'),
       ($4,$2,$5,'PRICE_ALERT','Hidden title','Hidden private body','hidden-source','AVAILABLE',($4::uuid)::text,clock_timestamp()-interval '2 minutes'),
       ($6,$2,NULL,'ACCOUNT_EMAIL','Global title','Global body',NULL,'AVAILABLE',($6::uuid)::text,clock_timestamp()-interval '1 minute'),
       ($7,$2,$3,'PRICE_ALERT','Created title','Created private body','created-source','CREATED',($7::uuid)::text,clock_timestamp()),
       ($8,$9,$5,'PRICE_ALERT','Other title','Other private body','other-source','AVAILABLE',($8::uuid)::text,clock_timestamp())`,
    [ownId, first.id, ownTrip, hiddenId, hiddenTrip, globalId, createdId, otherId, second.id],
  );

  const firstPage = await request(
    '/api/v1/me/notifications?limit=1&unread=true',
    'GET',
    undefined,
    bearer(first),
  );
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.data.length, 1);
  assert.equal(firstPage.body.data[0].id, globalId);
  assert.ok(firstPage.body.meta.next_cursor);
  const secondPage = await request(
    `/api/v1/me/notifications?limit=1&unread=true&cursor=${encodeURIComponent(firstPage.body.meta.next_cursor)}`,
    'GET',
    undefined,
    bearer(first),
  );
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.data[0].id, hiddenId);
  assert.equal(secondPage.body.data[0].trip_id, null);
  assert.equal(secondPage.body.data[0].source_id, null);
  assert.equal(JSON.stringify(secondPage.body).includes('Hidden private body'), false);
  assert.equal(
    (
      await request(
        `/api/v1/me/notifications?limit=1&unread=false&cursor=${encodeURIComponent(firstPage.body.meta.next_cursor)}`,
        'GET',
        undefined,
        bearer(first),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `/api/v1/me/notifications?limit=1&unread=true&cursor=${encodeURIComponent(`${firstPage.body.meta.next_cursor}x`)}`,
        'GET',
        undefined,
        bearer(first),
      )
    ).status,
    400,
  );
  const all = await request('/api/v1/me/notifications', 'GET', undefined, bearer(first));
  assert.deepEqual(
    all.body.data.map((item) => item.id),
    [globalId, hiddenId, ownId],
  );
  pass('API130 scopes AVAILABLE inbox, signs filter-bound pages and masks lost Trip access');

  assert.equal(
    (await request(`/api/v1/me/notifications/${ownId}/read`, 'PATCH', undefined, bearer(second)))
      .status,
    404,
  );
  const read = await request(
    `/api/v1/me/notifications/${ownId}/read`,
    'PATCH',
    undefined,
    bearer(first),
  );
  assert.equal(read.status, 200);
  assert.ok(read.body.data.read_at);
  const replayRead = await request(
    `/api/v1/me/notifications/${ownId}/read`,
    'PATCH',
    undefined,
    bearer(first),
  );
  assert.equal(replayRead.status, 200);
  assert.equal(replayRead.body.data.read_at, read.body.data.read_at);
  const readPage = await request(
    '/api/v1/me/notifications?unread=false',
    'GET',
    undefined,
    bearer(first),
  );
  assert.deepEqual(
    readPage.body.data.map((item) => item.id),
    [ownId],
  );
  const maskedRead = await request(
    `/api/v1/me/notifications/${hiddenId}/read`,
    'PATCH',
    undefined,
    bearer(first),
  );
  assert.equal(maskedRead.status, 200);
  assert.equal(maskedRead.body.data.trip_id, null);
  assert.equal(JSON.stringify(maskedRead.body).includes('Hidden private body'), false);
  pass('API131 is Self-only and idempotent while preserving source masking');
}
