import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import amqp from 'amqplib';

const require = createRequire(import.meta.url);
const { TripInvitationClient } = require('../packages/contracts/dist/trip-client.js');
const { TripClient } = require('../apps/api-gateway/dist/trip-client.js');

export async function runInvitationTests(ctx) {
  const {
    request,
    query,
    transaction,
    account,
    bearer,
    waitFor,
    pass,
    ports,
    infra,
    secrets,
    children,
    docker,
    startService,
    brokerUrl,
    automationPort,
  } = ctx;
  const owner = await account('Invitation Owner');
  const recipient = await account('Invitation Recipient');
  const outsider = await account('Invitation Outsider');
  const admin = await account('Invitation Admin', 'ADMIN');
  const tokens = [];
  const write = (path, user, body, key = randomUUID()) =>
    request(path, 'POST', body, { ...bearer(user), 'idempotency-key': key });
  const tripResult = await request(
    '/api/v1/trips',
    'POST',
    {
      name: 'Invitation integration',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      end_at: new Date(Date.now() + 172800000).toISOString(),
      client_request_id: randomUUID(),
    },
    bearer(owner),
  );
  assert.equal(tripResult.status, 201);
  const trip = tripResult.body.data;
  const path = `/api/v1/trips/${trip.id}/invitations`;
  const revision = async () =>
    (await query('trip', 'SELECT * FROM trips WHERE id=$1', [trip.id]))[0];
  const create = async (type = 'LINK', email, extra = {}, key = randomUUID()) =>
    write(
      path,
      owner,
      {
        invitation_type: type,
        ...(email ? { email } : {}),
        expected_membership_revision: (await revision()).membership_revision,
        ...extra,
      },
      key,
    );
  const token = (response) => {
    const value = new URLSearchParams(new URL(response.body.data.one_time_link).hash.slice(1)).get(
      'token',
    );
    assert.match(value, /^inv1_[A-Za-z0-9_-]{43}$/);
    tokens.push(value);
    return value;
  };
  const use = (action, user, value, key = randomUUID()) =>
    write(`/api/v1/invitations/${action}`, user, { token: value }, key);
  const inviteRow = async (id) =>
    (await query('trip', 'SELECT * FROM invitations WHERE id=$1', [id]))[0];
  const mail = async (email, count = 1) =>
    waitFor(async () => {
      const list = await (
        await fetch(`http://127.0.0.1:${infra.MAILPIT_UI_PORT}/api/v1/messages`)
      ).json();
      const found = list.messages.filter(
        (item) =>
          item.To?.some((address) => address.Address === email) &&
          item.Subject === 'Lời mời chuyến đi Wolfari',
      );
      if (found.length < count) return null;
      const latest = found.sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
      const detail = await (
        await fetch(`http://127.0.0.1:${infra.MAILPIT_UI_PORT}/api/v1/message/${latest.ID}`)
      ).json();
      return { text: detail.Text, count: found.length };
    }, 45000);
  const sent = async (id) =>
    waitFor(
      async () =>
        (
          await query(
            'automation',
            "SELECT * FROM notification_deliveries WHERE delivery_key=$1 AND status='SENT' AND NOT(private_context ? 'ack_pending')",
            [`invitation:${id}:1`],
          )
        )[0],
      45000,
    );
  const mailToken = (text) => {
    const value = new URLSearchParams(new URL(text.match(/https?:\/\/\S+/)[0]).hash.slice(1)).get(
      'token',
    );
    tokens.push(value);
    return value;
  };

  for (const user of [outsider, admin])
    assert.equal(
      (await write(path, user, { invitation_type: 'LINK', expected_membership_revision: 1 }))
        .status,
      404,
    );
  assert.equal(
    (
      await request(
        path,
        'POST',
        { invitation_type: 'LINK', expected_membership_revision: 1 },
        bearer(owner),
      )
    ).status,
    400,
  );
  assert.equal((await create('LINK', undefined, { actor_user_id: admin.id })).status, 400);
  assert.equal(
    (await request(`${path}?limit=2&limit=3`, 'GET', undefined, bearer(owner))).status,
    400,
  );
  assert.equal(
    (await write('/api/v1/invitations/preview', recipient, { token: 'invalid' })).status,
    400,
  );
  pass('Owner-only management, strict body/query and mandatory idempotency');

  const key = randomUUID(),
    body = { invitation_type: 'LINK', expected_membership_revision: 1 };
  const created = await write(path, owner, body, key);
  assert.equal(created.status, 201);
  const link = token(created),
    id = created.body.data.invitation.id;
  const replay = await write(path, owner, body, key);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.one_time_link, undefined);
  assert.equal(
    (
      await write(
        path,
        owner,
        { ...body, expires_at: new Date(Date.now() + 60000).toISOString() },
        key,
      )
    ).status,
    409,
  );
  assert.equal((await revision()).membership_revision, 1);
  const preview = await use('preview', recipient, link);
  assert.equal(preview.status, 200);
  assert.deepEqual(Object.keys(preview.body.data).sort(), [
    'expires_at',
    'id',
    'inviter_display_name',
    'status',
    'trip_name',
  ]);
  assert.equal((await inviteRow(id)).status, 'PENDING');
  const landing = await request('/invitations/local');
  assert.equal(landing.status, 200);
  assert.equal((await inviteRow(id)).status, 'PENDING');
  pass('one-time create projection, immutable replay and non-consuming recipient preview');

  const acceptKey = randomUUID();
  const races = await Promise.all([
    use('accept', recipient, link, acceptKey),
    use('accept', recipient, link, acceptKey),
  ]);
  for (const result of races) assert.equal(result.status, 200);
  assert.deepEqual(races[0].body.data, races[1].body.data);
  const member = races[0].body.data.membership;
  assert.equal((await inviteRow(id)).accepted_member_id, member.id);
  assert.deepEqual(races[0].body.data.revisions, {
    plan_version: 1,
    membership_revision: 2,
    export_revision: 2,
  });
  assert.equal(
    (
      await query(
        'trip',
        "SELECT * FROM outbox_events WHERE event_type='MemberJoined' AND aggregate_id=$1",
        [member.id],
      )
    ).length,
    1,
  );
  assert.deepEqual((await use('accept', recipient, link)).body.data, races[0].body.data);
  assert.equal((await use('accept', outsider, link)).status, 404);
  assert.equal(
    (await write(path, recipient, { invitation_type: 'LINK', expected_membership_revision: 2 }))
      .status,
    403,
  );
  await waitFor(
    async () =>
      (
        await query(
          'automation',
          "SELECT * FROM notifications WHERE type='MEMBER_JOINED' AND source_id=$1",
          [member.id],
        )
      ).length === 1,
  );
  pass('concurrent acceptance commits one membership, revisions, receipt and MemberJoined');

  const planPath = `/api/v1/trips/${trip.id}/plan`;
  const joinedPlan = await request(planPath, 'GET', undefined, bearer(recipient));
  assert.equal(joinedPlan.status, 200);
  assert.equal(joinedPlan.body.data.permissions.can_read, true);
  assert.equal(joinedPlan.body.data.permissions.can_edit, false);
  assert.equal((await request(planPath, 'GET', undefined, bearer(outsider))).status, 404);

  await query(
    'trip',
    'INSERT INTO trip_plan_editors(trip_id,trip_member_id,granted_by_user_id) VALUES($1,$2,$3)',
    [trip.id, member.id, owner.id],
  );
  await query(
    'trip',
    "UPDATE trip_members SET left_at=clock_timestamp(),left_reason='LEFT' WHERE id=$1",
    [member.id],
  );
  assert.equal((await use('accept', recipient, link, acceptKey)).status, 404);
  assert.equal((await request(planPath, 'GET', undefined, bearer(recipient))).status, 404);
  const rejoin = await create();
  assert.equal(rejoin.status, 201);
  const rejoined = await use('accept', recipient, token(rejoin));
  assert.equal(rejoined.status, 200);
  assert.notEqual(rejoined.body.data.membership.id, member.id);
  assert.equal(
    (
      await query('trip', 'SELECT 1 FROM trip_plan_editors WHERE trip_member_id=$1', [
        rejoined.body.data.membership.id,
      ])
    ).length,
    0,
  );
  assert.equal((await use('accept', recipient, link, acceptKey)).status, 404);
  pass('departed acceptance cannot replay through a later rejoin; editor rights are not restored');
  const rejoinedPlan = await request(planPath, 'GET', undefined, bearer(recipient));
  assert.equal(rejoinedPlan.status, 200);
  assert.equal(rejoinedPlan.body.data.permissions.can_edit, false);
  pass('Planning sees invitation membership changes without restoring editor privileges');

  const pending = await create();
  const pendingToken = token(pending);
  assert.equal((await use('accept', recipient, pendingToken)).status, 409);
  assert.equal((await inviteRow(pending.body.data.invitation.id)).status, 'PENDING');
  await query('trip', 'UPDATE trips SET closure_lock_id=$2 WHERE id=$1', [trip.id, randomUUID()]);
  assert.equal((await use('accept', outsider, pendingToken)).status, 409);
  await query('trip', 'UPDATE trips SET closure_lock_id=NULL WHERE id=$1', [trip.id]);
  for (const state of ['PROCESSING', 'PENDING_RECOVERY', 'NEEDS_REVIEW']) {
    const operation = randomUUID();
    await query(
      'trip',
      "INSERT INTO trip_operations(operation_id,trip_id,operation_type,actor_user_id,request_hash,state,context_revision,started_at) VALUES($1,$2,'TEST_GUARD',$3,'fixture',$4,1,clock_timestamp())",
      [operation, trip.id, owner.id, state],
    );
    assert.equal((await use('accept', outsider, pendingToken)).status, 409);
    await query('trip', 'DELETE FROM trip_operations WHERE operation_id=$1', [operation]);
  }
  pass(
    'active member, closure lock and all busy operation states block acceptance without consumption',
  );

  for (const table of ['trip_members', 'trip_audit_logs', 'trip_operations', 'outbox_events']) {
    const before = await revision();
    await query(
      'trip',
      `CREATE FUNCTION fail_invitation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$; CREATE TRIGGER fail_invitation_test BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_invitation_test()`,
    );
    try {
      assert.equal((await use('accept', outsider, pendingToken)).status, 503);
    } finally {
      await query(
        'trip',
        `DROP TRIGGER fail_invitation_test ON ${table}; DROP FUNCTION fail_invitation_test()`,
      );
    }
    assert.equal((await inviteRow(pending.body.data.invitation.id)).status, 'PENDING');
    assert.equal((await revision()).membership_revision, before.membership_revision);
    assert.equal(
      (
        await query('trip', 'SELECT 1 FROM trip_members WHERE trip_id=$1 AND user_id=$2', [
          trip.id,
          outsider.id,
        ])
      ).length,
      0,
    );
  }
  pass('injected membership/audit/receipt/outbox errors roll back every acceptance effect');

  const declinedKey = randomUUID();
  const declined = await use('decline', outsider, pendingToken, declinedKey);
  assert.equal(declined.status, 200);
  assert.equal(declined.body.data.status, 'DECLINED');
  assert.equal((await use('decline', outsider, pendingToken, declinedKey)).status, 200);
  assert.equal((await use('accept', outsider, pendingToken)).status, 409);
  const expiring = await create();
  const expiryToken = token(expiring);
  await query(
    'trip',
    "UPDATE invitations SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
    [expiring.body.data.invitation.id],
  );
  assert.equal((await use('preview', outsider, expiryToken)).status, 409);
  assert.equal((await inviteRow(expiring.body.data.invitation.id)).status, 'EXPIRED');
  assert.equal(
    (
      await query(
        'trip',
        "SELECT 1 FROM trip_audit_logs WHERE entity_id=$1 AND action='INVITATION_EXPIRED'",
        [expiring.body.data.invitation.id],
      )
    ).length,
    1,
  );
  pass('decline resolves LINK once; expiration commits even when request returns conflict');
  const waitingUser = await account('Waiting recipient');
  const waitingInvite = await create();
  const waitingToken = token(waitingInvite);
  let waitingRequest;
  await transaction('trip', async (client) => {
    await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [trip.id]);
    waitingRequest = use('accept', waitingUser, waitingToken);
    await waitFor(
      async () =>
        (
          await query(
            'trip',
            "SELECT 1 FROM pg_stat_activity WHERE datname='trip_db' AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM trips%'",
          )
        ).length > 0,
    );
    await client.query(
      "UPDATE invitations SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [waitingInvite.body.data.invitation.id],
    );
  });
  assert.equal((await waitingRequest).status, 409);
  assert.equal((await inviteRow(waitingInvite.body.data.invitation.id)).status, 'EXPIRED');
  let ownerRequest;
  await transaction('trip', async (client) => {
    await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [trip.id]);
    ownerRequest = create();
    await waitFor(
      async () =>
        (
          await query(
            'trip',
            "SELECT 1 FROM pg_stat_activity WHERE datname='trip_db' AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM trips%'",
          )
        ).length > 0,
    );
    await client.query(
      "UPDATE trip_members SET role='MEMBER' WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL",
      [trip.id, owner.id],
    );
  });
  assert.equal((await ownerRequest).status, 403);
  assert.equal((await write(path, owner, body, key)).status, 403);
  await query(
    'trip',
    "UPDATE trip_members SET role='OWNER' WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL",
    [trip.id, owner.id],
  );
  pass('PostgreSQL blocked requests re-read expiry and Owner authority after locks');

  const emailUser = waitingUser;
  const emailInvite = await create('EMAIL', `  ${emailUser.email.toUpperCase()}  `);
  assert.equal(emailInvite.status, 201);
  const emailLink = token(emailInvite),
    emailId = emailInvite.body.data.invitation.id;
  assert.equal((await create('EMAIL', emailUser.email)).status, 409);
  assert.equal((await use('preview', emailUser, emailLink)).status, 404);
  assert.equal((await use('preview', outsider, emailLink)).status, 404);
  const delivered = await mail(emailUser.email);
  assert.equal(mailToken(delivered.text), emailLink);
  await sent(emailId);
  assert.equal((await inviteRow(emailId)).delivery_token_ciphertext, null);
  await query('identity', 'UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1', [
    emailUser.id,
  ]);
  // Legacy V001 rows can retain mixed case/whitespace; V002 does not rewrite them.
  await query('trip', 'UPDATE invitations SET email=$2 WHERE id=$1', [
    emailId,
    `  ${emailUser.email.toUpperCase()}  `,
  ]);
  assert.equal((await use('preview', emailUser, emailLink)).status, 200);
  const resendKey = randomUUID();
  const resend = await write(
    `${path}/${emailId}/resend`,
    owner,
    { expected_version: 1 },
    resendKey,
  );
  assert.equal(resend.status, 200);
  assert.equal(resend.body.data.invitation.version, 2);
  assert.equal(resend.body.data.one_time_link, undefined);
  assert.equal(resend.body.data.invitation.expires_at, emailInvite.body.data.invitation.expires_at);
  assert.equal((await use('preview', emailUser, emailLink)).status, 404);
  const replacement = mailToken((await mail(emailUser.email, 2)).text);
  assert.notEqual(replacement, emailLink);
  assert.equal(
    (await write(`${path}/${emailId}/resend`, owner, { expected_version: 1 }, resendKey)).status,
    200,
  );
  const deliveryClient = new TripInvitationClient(
    `127.0.0.1:${ports.tripGrpc}`,
    secrets.AUTOMATION_TRIP_SECRET,
  );
  try {
    assert.equal(
      (
        await deliveryClient.getInvitationDelivery({
          invitation_id: emailId,
          expected_invitation_version: 1,
        })
      ).valid,
      false,
    );
    assert.equal(
      (
        await deliveryClient.acknowledgeInvitationDelivery({
          invitation_id: emailId,
          invitation_version: 1,
        })
      ).acknowledged,
      false,
    );
  } finally {
    deliveryClient.close();
  }
  const joinedEmail = await use('accept', emailUser, replacement);
  assert.equal(joinedEmail.status, 200);
  assert.equal((await create('EMAIL', emailUser.email)).status, 409);
  pass(
    'EMAIL requires verified matching identity; full SMTP delivery, version rotation and version-scoped ACK',
  );

  const unknown = `unknown-${randomUUID()}@example.test`;
  const emailRaces = await Promise.all([create('EMAIL', unknown), create('EMAIL', unknown)]);
  assert.deepEqual(emailRaces.map((result) => result.status).sort(), [201, 409]);
  const unknownInvite = emailRaces.find((result) => result.status === 201);
  await mail(unknown);
  await sent(unknownInvite.body.data.invitation.id);
  assert.equal(
    (await query('identity', 'SELECT 1 FROM users WHERE email=$1', [unknown])).length,
    0,
  );
  const muted = admin;
  await query('identity', 'UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1', [
    muted.id,
  ]);
  await query(
    'automation',
    'INSERT INTO notification_preferences(user_id,email_enabled) VALUES($1,false)',
    [muted.id],
  );
  const mutedInvite = await create('EMAIL', muted.email);
  const mutedId = mutedInvite.body.data.invitation.id;
  await waitFor(
    async () =>
      (
        await query(
          'automation',
          "SELECT 1 FROM notifications WHERE source_id=$1 AND type='TRIP_INVITATION'",
          [mutedId],
        )
      ).length === 1,
  );
  assert.equal(
    (
      await query('automation', 'SELECT 1 FROM notification_deliveries WHERE delivery_key=$1', [
        `invitation:${mutedId}:1`,
      ])
    ).length,
    0,
  );
  pass(
    'unregistered email recipient does not create account; preferences suppress email but retain notification',
  );

  const revoked = await create();
  const revokedId = revoked.body.data.invitation.id,
    revokedToken = token(revoked);
  assert.equal(
    (await write(`${path}/${revokedId}/revoke`, owner, { expected_version: 2 })).body.error.code,
    'VERSION_CONFLICT',
  );
  const revokeRaces = await Promise.all([
    write(`${path}/${revokedId}/revoke`, owner, { expected_version: 1 }),
    use('accept', outsider, revokedToken),
  ]);
  assert.equal(revokeRaces.filter((result) => result.status === 200).length, 1);
  const page = await request(`${path}?limit=2`, 'GET', undefined, bearer(owner));
  assert.equal(page.status, 200);
  assert.equal(page.body.data.items.length, 2);
  assert(page.body.data.next_cursor);
  const next = await request(
    `${path}?limit=2&cursor=${page.body.data.next_cursor}`,
    'GET',
    undefined,
    bearer(owner),
  );
  assert(
    !next.body.data.items.some((item) =>
      page.body.data.items.some((first) => first.id === item.id),
    ),
  );
  await query('trip', 'UPDATE trips SET archived_at=clock_timestamp() WHERE id=$1', [trip.id]);
  assert.equal((await request(path, 'GET', undefined, bearer(owner))).status, 200);
  assert.equal((await create()).status, 409);
  await query('trip', 'UPDATE trips SET archived_at=NULL WHERE id=$1', [trip.id]);
  pass('accept/revoke race has one winner, stable pagination and archived management is read-only');

  // Make ACK fail AFTER SMTP/SENT without adding a production failure hook.
  await query(
    'trip',
    `CREATE FUNCTION fail_invitation_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status='PENDING' AND OLD.delivery_token_ciphertext IS NOT NULL AND NEW.delivery_token_ciphertext IS NULL THEN RAISE EXCEPTION 'test ack outage'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_invitation_ack BEFORE UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION fail_invitation_ack()`,
  );
  const ackEmail = `ack-${randomUUID()}@example.test`;
  let ackId;
  try {
    const ackInvite = await create('EMAIL', ackEmail);
    ackId = ackInvite.body.data.invitation.id;
    await mail(ackEmail);
    await waitFor(
      async () =>
        (
          await query(
            'automation',
            "SELECT 1 FROM notification_deliveries WHERE delivery_key=$1 AND status='SENT' AND last_error='ACK_FAILED'",
            [`invitation:${ackId}:1`],
          )
        ).length === 1,
    );
  } finally {
    await query(
      'trip',
      'DROP TRIGGER fail_invitation_ack ON invitations; DROP FUNCTION fail_invitation_ack()',
    );
  }
  await query(
    'automation',
    'UPDATE notification_deliveries SET next_attempt_at=clock_timestamp() WHERE delivery_key=$1',
    [`invitation:${ackId}:1`],
  );
  await sent(ackId);
  assert.equal((await mail(ackEmail)).count, 1);
  assert.equal((await inviteRow(ackId)).delivery_token_ciphertext, null);
  pass('SENT survives ACK outage; ACK retry clears cipher without resending SMTP');

  await docker(['stop', 'mailpit']);
  const retryEmail = `retry-${randomUUID()}@example.test`;
  let retryId;
  try {
    const retryInvite = await create('EMAIL', retryEmail);
    retryId = retryInvite.body.data.invitation.id;
    await waitFor(
      async () =>
        (
          await query(
            'automation',
            "SELECT 1 FROM notification_deliveries WHERE delivery_key=$1 AND status='PENDING' AND attempt_count>0",
            [`invitation:${retryId}:1`],
          )
        ).length === 1,
    );
  } finally {
    await startService('mailpit');
  }
  await query(
    'automation',
    'UPDATE notification_deliveries SET next_attempt_at=clock_timestamp() WHERE delivery_key=$1',
    [`invitation:${retryId}:1`],
  );
  await mail(retryEmail);
  await sent(retryId);
  pass('SMTP outage retains pending delivery and recovery sends successfully');
  await docker(['stop', 'rabbitmq']);
  const brokerEmail = `broker-${randomUUID()}@example.test`;
  let brokerId;
  try {
    const brokerInvite = await create('EMAIL', brokerEmail);
    assert.equal(brokerInvite.status, 201);
    brokerId = brokerInvite.body.data.invitation.id;
    assert.equal(
      (await write(`${path}/${brokerId}/resend`, owner, { expected_version: 1 })).status,
      200,
    );
    assert.equal(
      (
        await query(
          'trip',
          "SELECT 1 FROM outbox_events WHERE aggregate_id=$1 AND status='PENDING'",
          [brokerId],
        )
      ).length,
      2,
    );
  } finally {
    await startService('rabbitmq');
  }
  const brokerMail = await mail(brokerEmail);
  assert.equal(brokerMail.count, 1);
  await waitFor(
    async () =>
      (
        await query(
          'automation',
          "SELECT 1 FROM notification_deliveries WHERE delivery_key=$1 AND status='SENT'",
          [`invitation:${brokerId}:2`],
        )
      ).length === 1,
  );
  assert.equal(
    (
      await query('automation', 'SELECT 1 FROM notification_deliveries WHERE delivery_key=$1', [
        `invitation:${brokerId}:1`,
      ])
    ).length,
    0,
  );
  pass('Trip outbox survives broker outage; stale version event does not send the rotated token');

  const rpc = new TripClient(`127.0.0.1:${ports.tripGrpc}`, secrets.GATEWAY_TRIP_SECRET);
  try {
    await assert.rejects(
      rpc.call('GetInvitationDelivery', { invitation_id: retryId }, randomUUID()),
      (error) => error.code === 7,
    );
  } finally {
    rpc.close();
  }
  const connection = await amqp.connect(brokerUrl());
  const channel = await connection.createChannel();
  try {
    const row = (
      await query(
        'trip',
        "SELECT * FROM outbox_events WHERE event_type='MemberInvited' AND aggregate_id=$1",
        [emailId],
      )
    )[0];
    const event = Object.fromEntries(
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
      ].map((key) => [key, row[key]]),
    );
    event.occurred_at = row.occurred_at.toISOString();
    channel.publish('wolfari.events.v1', 'MemberInvited', Buffer.from(JSON.stringify(event)), {
      persistent: true,
    });
    channel.sendToQueue(
      'wolfari.automation.invitations.v1',
      Buffer.from('{"event_type":"Unknown"}'),
      { persistent: true },
    );
    await waitFor(
      async () =>
        (await channel.checkQueue('wolfari.automation.invitations.v1.dlq')).messageCount >= 1,
    );
    await waitFor(
      async () =>
        (await channel.checkQueue('wolfari.automation.invitations.v1')).messageCount === 0,
    );
    assert.equal(
      (
        await query(
          'automation',
          "SELECT 1 FROM inbox_events WHERE consumer_name='AutomationInvitations' AND event_id=$1",
          [event.event_id],
        )
      ).length,
      1,
    );
  } finally {
    await channel.close();
    await connection.close();
  }
  pass('caller capability restrictions, duplicate event dedupe and unknown-contract DLQ');

  const privateData = JSON.stringify(
    await query('automation', 'SELECT private_context FROM notification_deliveries'),
  );
  const receipts = JSON.stringify(
    await query('trip', 'SELECT outcome,command_payload FROM trip_operations'),
  );
  const events = JSON.stringify(await query('trip', 'SELECT payload FROM outbox_events'));
  const audits = JSON.stringify(await query('trip', 'SELECT details FROM trip_audit_logs'));
  for (const value of tokens)
    for (const output of [
      privateData,
      receipts,
      events,
      audits,
      ...children.map((child) => child.output),
    ])
      assert(!output.includes(value), 'secret leaked outside RPC/email/create response');
  assert.equal((await fetch(`http://127.0.0.1:${automationPort}/health/invitations`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${ports.trip}/health/dependencies`)).status, 200);
  await query('trip', 'UPDATE trips SET deleted_at=clock_timestamp() WHERE id=$1', [trip.id]);
  assert.equal((await request(path, 'GET', undefined, bearer(owner))).status, 404);
  assert.equal((await write(path, owner, body, key)).status, 404);
  pass('safe diagnostics, secret-free persistence/logging and deleted-trip masking');
}
