import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/contracts/package.json', import.meta.url));
const { Client, credentials, Metadata, status } = require('@grpc/grpc-js');
const { loadSync } = require('@grpc/proto-loader');
const { PROTO_PATHS, GRPC_LOADER_OPTIONS } = require('@wolfari/contracts/grpc');
const identityTables = [
  'schema_migrations',
  'users',
  'credentials',
  'oauth_accounts',
  'refresh_sessions',
  'one_time_tokens',
  'admin_audit_logs',
  'outbox_events',
];
const privateName = 'NOTIFICATION ELIGIBILITY PRIVATE NAME';
const privateAvatar = 'private/notification-eligibility-avatar';

/** Run before other app/account activity so complete Identity snapshots stay deterministic. */
export async function runIdentityNotificationEligibilityTests({ query, target, secrets, pass }) {
  const methods = loadSync(PROTO_PATHS.identity, GRPC_LOADER_OPTIONS)[
    'wolfari.identity.v1.IdentityService'
  ];
  const client = new Client(target, credentials.createInsecure());
  const snapshot = () =>
    query(
      'identity',
      identityTables
        .map(
          (table) =>
            `SELECT '${table}' AS name,count(*)::text AS count,
      md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS fingerprint
      FROM ${table} t`,
        )
        .join(' UNION ALL ') + ' ORDER BY name',
    );
  const call = async (input, options = {}) => {
    const before = await snapshot();
    const metadata = new Metadata();
    const headers = {
      'x-caller-service': ['Automation'],
      'x-service-secret': [secrets.AUTOMATION_IDENTITY_SECRET],
      'x-correlation-id': [randomUUID()],
      ...options.headers,
    };
    for (const [key, values] of Object.entries(headers))
      for (const value of values) metadata.add(key, value);
    const method = methods[options.method ?? 'GetNotificationEligibility'];
    assert(method, 'GetNotificationEligibility must exist in the generated runtime contract');
    try {
      return await new Promise((resolve, reject) =>
        client.makeUnaryRequest(
          method.path,
          method.requestSerialize,
          method.responseDeserialize,
          input,
          metadata,
          { deadline: Date.now() + 3000 },
          (error, response) => (error ? reject(error) : resolve(response)),
        ),
      );
    } finally {
      assert.deepEqual(await snapshot(), before, 'eligibility RPC must not write Identity state');
    }
  };
  const denied = (input, options = {}, expectedCode = status.PERMISSION_DENIED) =>
    assert.rejects(call(input, options), (error) => error.code === expectedCode);
  const expected = (user_id, eligible) => ({ user_id, eligible });
  const check = async (ids, recipients) => {
    const response = await call({ user_ids: ids });
    assert.deepEqual(response, { recipients });
    assert.deepEqual(Object.keys(response), ['recipients']);
    for (const recipient of response.recipients) {
      assert.deepEqual(Object.keys(recipient).sort(), ['eligible', 'user_id']);
      assert.equal(typeof recipient.eligible, 'boolean');
    }
    for (const value of [privateName, privateAvatar, '@example.test'])
      assert(
        !JSON.stringify(response).includes(value),
        'eligibility response must omit profile/private fields',
      );
    return response;
  };
  try {
    // Synthetic defense states include ACTIVE rows with deletion stamps; no lifecycle is bypassed outside this isolated database.
    const users = {
      active: randomUUID(),
      verified: randomUUID(),
      locked: randomUUID(),
      deleting: randomUUID(),
      anonymized: randomUUID(),
      activeDeleting: randomUUID(),
      activeAnonymized: randomUUID(),
      activeBoth: randomUUID(),
    };
    const rows = [
      [users.active, 'ACTIVE', false, false, false],
      [users.verified, 'ACTIVE', true, false, false],
      [users.locked, 'LOCKED', true, false, false],
      [users.deleting, 'DELETION_PENDING', true, true, false],
      [users.anonymized, 'ANONYMIZED', true, true, true],
      [users.activeDeleting, 'ACTIVE', true, true, false],
      [users.activeAnonymized, 'ACTIVE', true, false, true],
      [users.activeBoth, 'ACTIVE', true, true, true],
    ];
    for (const [id, state, verified, deleting, anonymized] of rows)
      await query(
        'identity',
        `INSERT INTO users(id,email,full_name,avatar_object_key,status,
        email_verified_at,deletion_requested_at,anonymized_at) VALUES($1,$2,$3,$4,$5,
        CASE WHEN $6::boolean THEN clock_timestamp() END,
        CASE WHEN $7::boolean THEN clock_timestamp() END,
        CASE WHEN $8::boolean THEN clock_timestamp() END)`,
        [
          id,
          `eligibility-${id}@example.test`,
          privateName,
          privateAvatar,
          state,
          verified,
          deleting,
          anonymized,
        ],
      );
    const missing = randomUUID();
    const input = { user_ids: [users.active] };
    await check([users.active], [expected(users.active, true)]);
    pass(
      'Automation authenticates through the real eligibility gRPC method; unverified ACTIVE users remain eligible',
    );

    const callerKeys = {
      ApiGateway: 'GATEWAY_IDENTITY_SECRET',
      Trip: 'TRIP_IDENTITY_SECRET',
      Finance: 'FINANCE_IDENTITY_SECRET',
      Travel: 'TRAVEL_IDENTITY_SECRET',
      ExportWorker: 'EXPORT_IDENTITY_SECRET',
    };
    for (const [caller, key] of Object.entries(callerKeys))
      await denied(input, {
        headers: {
          'x-caller-service': [caller],
          'x-service-secret': [secrets[key]],
        },
      });
    await denied(input, { headers: { 'x-caller-service': ['UnknownService'] } });
    await denied({ user_id: users.active }, { method: 'GetInvitationIdentity' });
    pass(
      'all other valid service credentials are refused; Automation gains no invitation/email lookup access',
    );

    const correlation = randomUUID();
    const malformedHeaders = [
      { 'x-service-secret': ['wrong-notification-eligibility-secret'] },
      { 'x-service-secret': [secrets.TRIP_IDENTITY_SECRET] },
      { 'x-service-secret': [] },
      { 'x-caller-service': [] },
      { 'x-correlation-id': [] },
      { 'x-correlation-id': ['invalid-correlation'] },
      { 'x-caller-service': ['Automation', 'Automation'] },
      { 'x-caller-service': ['Automation', 'Trip'] },
      {
        'x-service-secret': [
          secrets.AUTOMATION_IDENTITY_SECRET,
          secrets.AUTOMATION_IDENTITY_SECRET,
        ],
      },
      { 'x-service-secret': [secrets.AUTOMATION_IDENTITY_SECRET, 'wrong-secret'] },
      { 'x-correlation-id': [correlation, correlation] },
    ];
    for (const headers of malformedHeaders) await denied(input, { headers });
    await denied({}, { headers: { 'x-caller-service': [] } });
    pass(
      'wrong, absent and duplicate credential/correlation metadata fail closed before request validation',
    );

    await check(Object.values(users).concat(missing), [
      expected(users.active, true),
      expected(users.verified, true),
      expected(users.locked, false),
      expected(users.deleting, false),
      expected(users.anonymized, false),
      expected(users.activeDeleting, false),
      expected(users.activeAnonymized, false),
      expected(users.activeBoth, false),
      expected(missing, false),
    ]);
    pass(
      'all stored account states and inconsistent ACTIVE deletion/anonymization stamps resolve safely; missing IDs are ineligible',
    );

    await check(
      [users.locked.toUpperCase(), users.active.toUpperCase(), users.locked, missing, users.active],
      [expected(users.locked, false), expected(users.active, true), expected(missing, false)],
    );
    await check(Array(100).fill(users.active.toUpperCase()), [expected(users.active, true)]);
    pass(
      'UUID normalization preserves first-seen unique order and accepts a legal raw batch of repeated IDs',
    );

    const maximum = [
      users.active,
      users.verified,
      ...Array.from({ length: 98 }, () => randomUUID()),
    ];
    await check(
      maximum,
      maximum.map((id, index) => expected(id, index < 2)),
    );
    for (const ids of [
      [],
      Array(101).fill(users.active),
      maximum.concat(randomUUID()),
      [''],
      ['not-a-uuid'],
      [` ${users.active}`],
      [`${users.active} `],
      [users.active, 'not-a-uuid'],
      ['00000000-0000-0000-0000-000000000000'],
    ])
      await denied({ user_ids: ids }, {}, status.INVALID_ARGUMENT);
    await denied({}, {}, status.INVALID_ARGUMENT);
    pass(
      'exact 100-ID boundary succeeds; empty, over-limit raw and malformed/whitespace UUID batches are rejected atomically',
    );

    for (const [state, deleting, anonymized, eligible] of [
      ['LOCKED', false, false, false],
      ['ACTIVE', false, false, true],
      ['ACTIVE', true, false, false],
      ['ACTIVE', false, false, true],
      ['ACTIVE', false, true, false],
      ['DELETION_PENDING', true, false, false],
      ['ANONYMIZED', true, true, false],
    ]) {
      await query(
        'identity',
        `UPDATE users SET status=$2,
        deletion_requested_at=CASE WHEN $3::boolean THEN clock_timestamp() END,
        anonymized_at=CASE WHEN $4::boolean THEN clock_timestamp() END WHERE id=$1`,
        [users.active, state, deleting, anonymized],
      );
      await check([users.active], [expected(users.active, eligible)]);
    }
    await query('identity', 'DELETE FROM users WHERE id=$1', [users.active]);
    await check([users.active], [expected(users.active, false)]);
    pass(
      'subsequent eligibility reads reflect lock, restore, deletion, anonymization and missing-row transitions without cached authorization',
    );
    pass(
      'every successful and rejected RPC preserves all eight Identity table fingerprints and returns only user_id/eligible',
    );
  } finally {
    client.close();
  }
}
