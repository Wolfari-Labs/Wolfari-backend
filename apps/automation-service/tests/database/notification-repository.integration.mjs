import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NotificationRepository } = require('../../dist/notification/notification.repository.js');

/** Called by the isolated db:test runner after Automation V005. */
export async function checkNotificationRepository(client) {
  const database = {
    query: client.query.bind(client),
    withTransaction: (work) => work(client),
  };
  const repository = new NotificationRepository(database);
  const first = randomUUID();
  const second = randomUUID();
  const token = `integration-token-${randomUUID()}-${randomUUID()}`;

  await client.query('BEGIN');
  try {
    assert.deepEqual(await repository.getPreference(first), {
      push_enabled: true,
      email_enabled: true,
      group_overrides: {},
      version: 1,
    });
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM notification_preferences')).rows[0].n,
      0,
    );
    const initial = await repository.updatePreference({
      userId: first,
      pushEnabled: false,
      emailEnabled: true,
      groupOverrides: { PRICE: { push: true, email: false } },
      expectedVersion: 1,
    });
    assert.equal(initial.version, 2);
    await assert.rejects(
      repository.updatePreference({
        userId: first,
        pushEnabled: true,
        emailEnabled: true,
        groupOverrides: {},
        expectedVersion: 1,
      }),
      (error) => error.code === 'VERSION_CONFLICT' && error.details.current_version === 2,
    );
    const replaced = await repository.updatePreference({
      userId: first,
      pushEnabled: true,
      emailEnabled: false,
      groupOverrides: { INVITATION: { email: false } },
      expectedVersion: 2,
    });
    assert.deepEqual(replaced.group_overrides, { INVITATION: { email: false } });
    assert.equal(replaced.version, 3);

    const device = await repository.registerDevice({ userId: first, platform: 'WEB', token });
    const replay = await repository.registerDevice({ userId: first, platform: 'ANDROID', token });
    assert.equal(replay.id, device.id);
    assert.equal(replay.platform, 'ANDROID');
    await assert.rejects(
      repository.registerDevice({ userId: second, platform: 'WEB', token }),
      (error) => error.code === 'STATE_CONFLICT',
    );
    await repository.deleteDevice(second, device.id);
    assert.equal(
      (await client.query('SELECT user_id FROM device_tokens WHERE id=$1', [device.id])).rows[0]
        .user_id,
      first,
    );
    await repository.deleteDevice(first, device.id);
    await repository.deleteDevice(first, device.id);
    assert.equal(
      (await repository.registerDevice({ userId: second, platform: 'WEB', token })).active,
      true,
    );

    const trip = randomUUID();
    const unreadId = randomUUID();
    const readId = randomUUID();
    const createdId = randomUUID();
    const foreignId = randomUUID();
    await client.query(
      `INSERT INTO notifications(id,user_id,trip_id,type,title,body,status,dedupe_key,created_at,read_at)
       VALUES
         ($1,$2,$3,'PRICE_ALERT','Unread','Body','AVAILABLE',($1::uuid)::text,clock_timestamp()-interval '2 minutes',NULL),
         ($4,$2,NULL,'ACCOUNT_EMAIL','Read','Body','AVAILABLE',($4::uuid)::text,clock_timestamp()-interval '1 minute',clock_timestamp()),
         ($5,$2,$3,'PRICE_ALERT','Created','Body','CREATED',($5::uuid)::text,clock_timestamp(),NULL),
         ($6,$7,$3,'PRICE_ALERT','Foreign','Body','AVAILABLE',($6::uuid)::text,clock_timestamp(),NULL)`,
      [unreadId, first, trip, readId, createdId, foreignId, second],
    );
    assert.deepEqual(
      (await repository.listNotifications(first, 'ALL', 10)).map((item) => item.id),
      [readId, unreadId],
    );
    assert.deepEqual(
      (await repository.listNotifications(first, 'UNREAD', 10)).map((item) => item.id),
      [unreadId],
    );
    assert.deepEqual(
      (await repository.listNotifications(first, 'READ', 10)).map((item) => item.id),
      [readId],
    );
    const firstRead = await repository.markRead(first, unreadId);
    const replayRead = await repository.markRead(first, unreadId);
    assert.equal(firstRead.read_at, replayRead.read_at);
    await assert.rejects(
      repository.markRead(second, unreadId),
      (error) => error.code === 'RESOURCE_NOT_FOUND',
    );
    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname`,
      [['ix_notifications_user_available', 'ix_notifications_user_unread']],
    );
    assert.deepEqual(
      indexes.rows.map((row) => row.indexname),
      ['ix_notifications_user_available', 'ix_notifications_user_unread'],
    );
  } finally {
    await client.query('ROLLBACK');
  }
}
