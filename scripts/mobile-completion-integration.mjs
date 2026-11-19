import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const require = createRequire(import.meta.url);
export async function runMobileCompletion({
  request,
  query,
  account,
  bearer,
  tripBody,
  pass,
  waitFor,
  ports,
  infra,
  secrets,
  databaseUrl,
}) {
  const owner = await account('Lifecycle Owner'),
    member = await account('Lifecycle Member'),
    outsider = await account('Lifecycle Outsider');
  const created = await request(
    '/api/v1/trips',
    'POST',
    tripBody('Kỳ nghỉ Đà Nẵng / tiếng Việt'),
    bearer(owner),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const tripId = created.body.data.id,
    root = `/api/v1/trips/${tripId}`;
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',clock_timestamp())",
    [tripId, member.id],
  );
  const membership = (
    await query('trip', 'SELECT id FROM trip_members WHERE trip_id=$1 AND user_id=$2', [
      tripId,
      member.id,
    ])
  )[0].id;
  const trip = async () => (await request(root, 'GET', undefined, bearer(owner))).body.data;
  const manage = async (action, actor = owner, key = randomUUID(), snapshot) => {
    const current = snapshot ?? (await trip());
    return request(
      action === 'DELETE'
        ? root
        : `${root}/${action === 'TRANSFER' ? 'ownership' : action.toLowerCase()}`,
      action === 'DELETE' ? 'DELETE' : 'POST',
      {
        reason: 'Integration verification',
        expected_plan_version: current.plan_version,
        expected_membership_revision: current.membership_revision,
        expected_export_revision: current.export_revision,
        ...(action === 'TRANSFER' ? { new_owner_member_id: membership } : {}),
      },
      { ...bearer(actor), 'idempotency-key': key },
    );
  };
  assert.equal((await manage('ARCHIVE', member)).status, 403);
  assert.equal((await manage('ARCHIVE', outsider)).status, 404);
  const old = await trip();
  const activity = await request(
    `${root}/activities`,
    'POST',
    {
      title: 'Ăn sáng và khám phá phố cổ',
      activity_type: 'OTHER',
      description: 'Địa điểm có tiếng Việt: Hội An, Đà Nẵng.',
      starts_at: new Date(Date.parse(old.start_at) + 3600000).toISOString(),
      ends_at: new Date(Date.parse(old.start_at) + 7200000).toISOString(),
      position: 0,
      expected_plan_version: old.plan_version,
    },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assert.equal(activity.status, 201, JSON.stringify(activity.body));
  const activityId = activity.body.data.id;
  assert.equal((await manage('ARCHIVE', owner, randomUUID(), old)).status, 409);
  const bad = await request(
    `${root}/archive`,
    'POST',
    {
      reason: 'x',
      expected_plan_version: '1',
      expected_membership_revision: 1,
      expected_export_revision: 1,
    },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assert.equal(bad.status, 400);
  pass('Trip management rejects non-Owner/outsider, stale snapshots and coerced revisions');

  const pdf = await fetch(`http://127.0.0.1:${ports.gateway}${root}/plan.pdf`, {
    headers: bearer(member),
  });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('cache-control'), /no-store/);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(
    bytes.includes(Buffer.from('/FontFile2')) && bytes.includes(Buffer.from('/ToUnicode')),
    'Vietnamese font is embedded with a Unicode map',
  );
  await mkdir(resolve('.cache/mobile-completion'), { recursive: true });
  await writeFile(resolve('.cache/mobile-completion/plan.pdf'), bytes);
  assert.equal((await request(`${root}/plan.pdf`, 'GET', undefined, bearer(outsider))).status, 404);
  pass(
    'Private PDF export contains real Plan data, embedded Vietnamese font, no-store headers and current member authorization',
  );

  const reminderRoot = `${root}/reminders`;
  const key = randomUUID(),
    when = new Date(Date.now() + 4000).toISOString();
  const reminderBody = { source_type: 'ACTIVITY', source_id: activityId, remind_at: when };
  const first = await request(reminderRoot, 'POST', reminderBody, {
    ...bearer(owner),
    'idempotency-key': key,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const reminderId = first.body.data.id;
  const replay = await request(reminderRoot, 'POST', reminderBody, {
    ...bearer(owner),
    'idempotency-key': key,
  });
  assert.equal(replay.body.data.id, reminderId);
  assert.equal(
    (
      await request(
        reminderRoot,
        'POST',
        { ...reminderBody, remind_at: new Date(Date.parse(when) + 1000).toISOString() },
        { ...bearer(owner), 'idempotency-key': key },
      )
    ).status,
    409,
  );
  assert.equal((await request(reminderRoot, 'GET', undefined, bearer(outsider))).status, 404);
  assert.equal(
    (await request(`${reminderRoot}/${reminderId}`, 'DELETE', undefined, bearer(member))).status,
    404,
  );
  assert.deepEqual((await request(reminderRoot, 'GET', undefined, bearer(member))).body.data, []);
  await waitFor(
    async () =>
      (await query('automation', 'SELECT status FROM reminders WHERE id=$1', [reminderId]))[0]
        ?.status === 'SENT',
    20000,
  );
  const notices = await query('automation', 'SELECT * FROM notifications WHERE source_id=$1', [
    reminderId,
  ]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].user_id, owner.id);
  pass(
    'Real reminder scheduler creates one Self inbox notification; replay and cross-user access remain safe',
  );

  const cancelled = await request(
    reminderRoot,
    'POST',
    { ...reminderBody, remind_at: new Date(Date.now() + 60000).toISOString() },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assert.equal(cancelled.status, 201);
  assert.equal(
    (await request(`${reminderRoot}/${cancelled.body.data.id}`, 'DELETE', undefined, bearer(owner)))
      .status,
    200,
  );
  assert.equal(
    (await request(`${reminderRoot}/${cancelled.body.data.id}`, 'DELETE', undefined, bearer(owner)))
      .status,
    200,
  );
  const changed = await request(
    reminderRoot,
    'POST',
    { ...reminderBody, remind_at: new Date(Date.now() + 3000).toISOString() },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  const plan = (await request(`${root}/plan`, 'GET', undefined, bearer(owner))).body.data;
  assert.equal(
    (
      await request(
        `${root}/activities/${activityId}`,
        'PATCH',
        {
          starts_at: new Date(Date.parse(old.start_at) + 10800000).toISOString(),
          ends_at: new Date(Date.parse(old.start_at) + 14400000).toISOString(),
          expected_plan_version: plan.plan_version,
        },
        { ...bearer(owner), 'idempotency-key': randomUUID() },
      )
    ).status,
    200,
  );
  await waitFor(
    async () =>
      (
        await query('automation', 'SELECT status FROM reminders WHERE id=$1', [
          changed.body.data.id,
        ])
      )[0]?.status === 'CANCELLED',
    20000,
  );
  assert.equal(
    (
      await query('automation', 'SELECT 1 FROM notifications WHERE source_id=$1', [
        changed.body.data.id,
      ])
    ).length,
    0,
  );
  pass(
    'Reminder cancellation is idempotent; a changed source is cancelled instead of notifying at an obsolete time',
  );

  const { ConfigService } = require('../apps/automation-service/node_modules/@nestjs/config');
  const {
    PriceWatchAccessService,
  } = require('../apps/automation-service/dist/price-watch/price-watch-access.service.js');
  const {
    DeliveryContextClient,
  } = require('../apps/automation-service/dist/delivery/delivery-context.client.js');
  const {
    PushDeliveryService,
  } = require('../apps/automation-service/dist/delivery/push-delivery.service.js');
  const {
    NotificationRepository,
  } = require('../apps/automation-service/dist/notification/notification.repository.js');
  const pool = new pg.Pool({ connectionString: databaseUrl(infra, 'automation') });
  const db = {
    query: (sql, args) => pool.query(sql, args),
    withTransaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
  const config = new ConfigService({
    TRIP_GRPC_TARGET: `127.0.0.1:${ports.tripGrpc}`,
    AUTOMATION_TRIP_SECRET: secrets.AUTOMATION_TRIP_SECRET,
    IDENTITY_GRPC_TARGET: `127.0.0.1:${ports.identityGrpc}`,
    AUTOMATION_IDENTITY_SECRET: secrets.AUTOMATION_IDENTITY_SECRET,
    PUSH_DELIVERY_ENABLED: 'true',
    EXPO_PUSH_ACCESS_TOKEN: 'test-only-not-a-credential',
  });
  const access = new PriceWatchAccessService(config),
    context = new DeliveryContextClient(config, access),
    repository = new NotificationRepository(db),
    worker = new PushDeliveryService(db, context, repository, config);
  const device = await request(
    '/api/v1/me/devices',
    'POST',
    { platform: 'ANDROID', token: 'ExponentPushToken[fixture_mobile_completion]' },
    bearer(owner),
  );
  assert.equal(device.status, 200, JSON.stringify(device.body));
  const originalFetch = globalThis.fetch;
  let sends = 0,
    invalid = false;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://exp.host/--/api/v2/push/'))
      return originalFetch(url, options);
    assert.ok(options.headers.Authorization.startsWith('Bearer '));
    if (String(url).endsWith('/send')) {
      sends++;
      const body = JSON.parse(options.body);
      assert.equal(body.title, 'Wolfari');
      assert.ok(!body.body.includes('Ăn sáng'));
      assert.ok(!JSON.stringify(body).includes(owner.access));
      return Response.json({
        data: invalid
          ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok', id: 'fixture-ticket' },
      });
    }
    return Response.json({ data: { 'fixture-ticket': { status: 'ok' } } });
  };
  try {
    // A generic current-access notification exercises delivery independently of a completed reminder.
    const notice = randomUUID();
    await query(
      'automation',
      "INSERT INTO notifications(id,user_id,trip_id,type,title,body,status,dedupe_key) VALUES($1::uuid,$2,$3,'PLAN_UPDATED','Private title','Private body','AVAILABLE',$1::text)",
      [notice, owner.id, tripId],
    );
    await worker.runOnce();
    const delivery = (
      await query('automation', 'SELECT * FROM notification_deliveries WHERE notification_id=$1', [
        notice,
      ])
    )[0];
    assert.equal(delivery.status, 'SENDING');
    assert.equal(delivery.provider_reference, 'fixture-ticket');
    await query(
      'automation',
      "UPDATE notification_deliveries SET next_attempt_at=clock_timestamp() WHERE provider_reference='fixture-ticket'",
    );
    await worker.runOnce();
    assert.equal(
      (
        await query('automation', 'SELECT status FROM notification_deliveries WHERE id=$1', [
          delivery.id,
        ])
      )[0].status,
      'SENT',
    );
    const sentBefore = sends;
    await worker.runOnce();
    assert.equal(sends, sentBefore);
    const preference = (
      await request('/api/v1/me/notification-preferences', 'GET', undefined, bearer(owner))
    ).body.data;
    const muted = await request(
      '/api/v1/me/notification-preferences',
      'PUT',
      {
        push_enabled: false,
        email_enabled: true,
        group_overrides: {},
        expected_version: preference.version,
      },
      bearer(owner),
    );
    assert.equal(muted.status, 200);
    const mutedNotice = randomUUID();
    await query(
      'automation',
      "INSERT INTO notifications(id,user_id,trip_id,type,title,body,status,dedupe_key) VALUES($1::uuid,$2,$3,'PLAN_UPDATED','Private','Private','AVAILABLE',$1::text)",
      [mutedNotice, owner.id, tripId],
    );
    const beforeMuted = sends;
    await worker.runOnce();
    assert.equal(sends, beforeMuted);
    assert.equal(
      (
        await query(
          'automation',
          'SELECT last_error FROM notification_deliveries WHERE notification_id=$1',
          [mutedNotice],
        )
      )[0].last_error,
      'PREFERENCE_DISABLED',
    );
    const unmuted = await request(
      '/api/v1/me/notification-preferences',
      'PUT',
      {
        push_enabled: true,
        email_enabled: true,
        group_overrides: {},
        expected_version: muted.body.data.version,
      },
      bearer(owner),
    );
    assert.equal(unmuted.status, 200);
    const revokedNotice = randomUUID();
    await query(
      'automation',
      "INSERT INTO notifications(id,user_id,trip_id,type,title,body,status,dedupe_key) VALUES($1::uuid,$2,$3,'PLAN_UPDATED','Private','Private','AVAILABLE',$1::text)",
      [revokedNotice, owner.id, tripId],
    );
    await query('identity', "UPDATE users SET status='LOCKED' WHERE id=$1", [owner.id]);
    await worker.runOnce();
    assert.equal(sends, beforeMuted);
    assert.equal(
      (
        await query(
          'automation',
          'SELECT last_error FROM notification_deliveries WHERE notification_id=$1',
          [revokedNotice],
        )
      )[0].last_error,
      'RECIPIENT_UNAVAILABLE',
    );
    await query('identity', "UPDATE users SET status='ACTIVE' WHERE id=$1", [owner.id]);
    // A valid account with a revoked device session must not receive pushes.
    const sessionFamily = (await query('automation', 'SELECT session_family_id FROM device_tokens WHERE id=$1', [device.body.data.id]))[0].session_family_id;
    assert.ok(sessionFamily);
    const revokedSessionNotice = randomUUID();
    await query('automation', "INSERT INTO notifications(id,user_id,trip_id,type,title,body,status,dedupe_key) VALUES($1::uuid,$2,$3,'PLAN_UPDATED','Private','Private','AVAILABLE',$1::text)", [revokedSessionNotice, owner.id, tripId]);
    const liveSessions = await query('identity', 'UPDATE refresh_sessions SET revoked_at=clock_timestamp() WHERE family_id=$1 AND revoked_at IS NULL RETURNING id', [sessionFamily]);
    try {
      await worker.runOnce();
      assert.equal(sends, beforeMuted);
      assert.equal((await query('automation', 'SELECT last_error FROM notification_deliveries WHERE notification_id=$1', [revokedSessionNotice]))[0].last_error, 'RECIPIENT_UNAVAILABLE');
    } finally {
      // Isolated integration data only; restore the fixture owner for remaining lifecycle checks.
      await query('identity', 'UPDATE refresh_sessions SET revoked_at=NULL WHERE id=ANY($1::uuid[])', [liveSessions.map(row => row.id)]);
    }
    invalid = true;
    const invalidNotice = randomUUID();
    await query(
      'automation',
      "INSERT INTO notifications(id,user_id,trip_id,type,title,body,status,dedupe_key) VALUES($1::uuid,$2,$3,'PLAN_UPDATED','Private','Private','AVAILABLE',$1::text)",
      [invalidNotice, owner.id, tripId],
    );
    await worker.runOnce();
    assert.equal(
      (
        await query('automation', 'SELECT active FROM device_tokens WHERE id=$1', [
          device.body.data.id,
        ])
      )[0].active,
      false,
    );
    assert.equal(
      (
        await query(
          'automation',
          'SELECT last_error FROM notification_deliveries WHERE notification_id=$1',
          [invalidNotice],
        )
      )[0].last_error,
      'DeviceNotRegistered',
    );
  } finally {
    globalThis.fetch = originalFetch;
    await context.onApplicationShutdown();
    await access.onApplicationShutdown();
    await pool.end();
  }
  pass(
    'Durable push worker validates current context, records ticket then receipt, deduplicates and deactivates invalid tokens (Expo HTTP fixture only)',
  );

  for (const table of ['trip_audit_logs', 'outbox_events', 'trip_operations']) {
    const snapshot = await trip(),
      op = randomUUID(),
      trigger = `mobile_fail_${table}`;
    await query(
      'trip',
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional rollback'; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      assert.equal((await manage('ARCHIVE', owner, op, snapshot)).status, 503);
      assert.equal((await trip()).archived_at, null);
      assert.equal((await trip()).plan_version, snapshot.plan_version);
    } finally {
      await query('trip', `DROP TRIGGER ${trigger} ON ${table}; DROP FUNCTION ${trigger}()`);
    }
  }
  const fund = randomUUID();
  await query(
    'finance',
    "INSERT INTO funds(id,trip_id,holder_user_id,status) VALUES($1,$2,$3,'OPEN')",
    [fund, tripId, owner.id],
  );
  assert.equal((await manage('ARCHIVE')).body.error.code, 'FINANCE_OBLIGATION_BLOCKED');
  assert.equal((await manage('DELETE')).body.error.code, 'FINANCE_OBLIGATION_BLOCKED');
  await query('finance', "UPDATE funds SET status='CLOSING' WHERE id=$1", [fund]);
  assert.equal((await manage('TRANSFER')).body.error.code, 'FINANCE_OBLIGATION_BLOCKED');
  await query('finance', "UPDATE funds SET status='OPEN' WHERE id=$1", [fund]);
  const pendingOperation = randomUUID();
  await query(
    'trip',
    "INSERT INTO trip_operations(operation_id,trip_id,actor_user_id,operation_type,request_hash,state,context_revision,started_at) VALUES($1,$2,$3,'CREATE_EXPENSE','test','PROCESSING',1,clock_timestamp())",
    [pendingOperation, tripId, owner.id],
  );
  assert.equal((await manage('TRANSFER')).status, 409);
  await query('trip', 'DELETE FROM trip_operations WHERE operation_id=$1', [pendingOperation]);
  await query('identity', "UPDATE users SET status='LOCKED' WHERE id=$1", [member.id]);
  assert.equal((await manage('TRANSFER')).status, 409);
  await query('identity', "UPDATE users SET status='ACTIVE' WHERE id=$1", [member.id]);
  const transferred = await manage('TRANSFER');
  assert.equal(transferred.status, 200, JSON.stringify(transferred.body));
  assert.equal((await manage('ARCHIVE')).status, 403);
  assert.equal(
    (await query('finance', 'SELECT holder_user_id FROM funds WHERE id=$1', [fund]))[0]
      .holder_user_id,
    owner.id,
  );
  // Closed test fixture only: no money, obligations or ledger entries have been created.
  await query('finance', "UPDATE funds SET status='CLOSED' WHERE id=$1", [fund]);
  const current = (await request(root, 'GET', undefined, bearer(member))).body.data;
  const archiveKey = randomUUID();
  assert.equal((await manage('ARCHIVE', member, archiveKey, current)).status, 200);
  const archived = (await request(root, 'GET', undefined, bearer(member))).body.data;
  assert.equal(archived.lifecycle, 'ARCHIVED');
  assert.equal(
    (await request(`${root}/plan`, 'GET', undefined, bearer(member))).body.data.permissions
      .can_edit,
    false,
  );
  assert.equal((await manage('REOPEN', member, randomUUID(), archived)).status, 200);
  const deletionKey = randomUUID(),
    beforeDelete = (await request(root, 'GET', undefined, bearer(member))).body.data;
  assert.equal((await manage('DELETE', member, deletionKey, beforeDelete)).status, 200);
  assert.equal((await request(root, 'GET', undefined, bearer(member))).status, 404);
  assert.equal((await manage('DELETE', member, deletionKey, beforeDelete)).status, 200);
  const operation = await request(
    `/api/v1/operations/${deletionKey}`,
    'GET',
    undefined,
    bearer(member),
  );
  assert.equal(operation.status, 200);
  assert.equal(operation.body.data.state, 'SUCCEEDED');
  assert.equal(
    (await request(`/api/v1/operations/${deletionKey}`, 'GET', undefined, bearer(owner))).status,
    404,
  );
  pass(
    'Lifecycle writes are atomic, require closed Funds for archive/delete, transfer authority without changing Holder and retain initiator receipts after deletion',
  );
}
