import { runPlanScenarios } from './plan-integration.mjs';
import { startLifecycleFinanceFixture } from './trip-members-fixture.mjs';
import { runMembershipTests } from './trip-members-integration.mjs';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { appEnvironment, apps, databaseUrl, root } from './config.mjs';
import { compose } from './infrastructure.mjs';
import { startTestService } from './test-container.mjs';
import { migrate, migrationFiles } from './migrations.mjs';
import { runInvitationTests } from './trip-invitations-integration.mjs';

const invitationMode = process.argv.includes('--invitations');
const membershipMode = process.argv.includes('--members');
let financeFixture;
function brokerUrl() {
  const value = new URL(`amqp://127.0.0.1:${infra.RABBITMQ_PORT}`);
  value.username = infra.RABBITMQ_DEFAULT_USER;
  value.password = infra.RABBITMQ_DEFAULT_PASS;
  return value.href;
}

const require = createRequire(import.meta.url);
const { TripClient } = require('../apps/api-gateway/dist/trip-client.js');
const { TripAccessClient } = require('../packages/contracts/dist/trip-client.js');
const { TripAccessService } = require('../apps/trip-workspace-service/dist/trip-access.service.js');
const {
  TripPlanAccessService,
} = require('../apps/trip-workspace-service/dist/trip-plan-access.service.js');

const project = `wolfari-trip-test-${randomBytes(5).toString('hex')}`;
const children = [];
let directory;
let infra;
let created = false;
let checks = 0;
const pass = (message) => {
  checks++;
  console.log(`PASS ${message}`);
};

async function port() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const value = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return value;
}

async function waitFor(work, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await work();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw last ?? new Error('TEST_TIMEOUT');
}

function docker(args) {
  return compose(infra, args, { project, envFile: resolve(directory, '.env') });
}

async function query(service, sql, params = []) {
  const client = new pg.Client({ connectionString: databaseUrl(infra, service) });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function transaction(service, work) {
  const client = new pg.Client({ connectionString: databaseUrl(infra, service) });
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function adminQuery(sql, params = []) {
  const url = new URL(`postgresql://127.0.0.1:${infra.POSTGRES_PORT}/postgres`);
  url.username = infra.POSTGRES_USER;
  url.password = infra.POSTGRES_PASSWORD;
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function start(name, values) {
  const app = apps.find((item) => item.name === name);
  const child = fork(resolve(root, 'apps', name, 'dist/main.js'), [], {
    cwd: root,
    env: {
      ...appEnvironment(app, { NODE_ENV: 'test', ...values }),
      ...(values.TZ ? { TZ: values.TZ } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child.appName = name;
  child.output = '';
  child.stdout.on('data', (data) => {
    child.output = (child.output + String(data)).slice(-100_000);
  });
  child.stderr.on('data', (data) => {
    child.output = (child.output + String(data)).slice(-100_000);
  });
  children.push(child);
  const portValue = Number(values[app.portKey]);
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`${name} exited: ${child.output.slice(-1500)}`);
    return (
      await fetch(`http://127.0.0.1:${portValue}/health/live`, {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send('shutdown');
  await waitFor(() => child.exitCode !== null, 10_000);
}

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${ports.gateway}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    body: type.includes('json') ? await response.json() : await response.text(),
  };
}

const ports = { gateway: 0, identity: 0, trip: 0, identityGrpc: 0, tripGrpc: 0 };
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const secrets = {
  IDENTITY_ACCESS_PRIVATE_KEY: pair.privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .toString('base64'),
  IDENTITY_ACCESS_PUBLIC_KEY: pair.publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64'),
  IDENTITY_TOKEN_KEY: randomBytes(32).toString('hex'),
  GATEWAY_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  GATEWAY_TRIP_SECRET: randomBytes(32).toString('hex'),
  FINANCE_TRIP_SECRET: randomBytes(32).toString('hex'),
  TRAVEL_TRIP_SECRET: randomBytes(32).toString('hex'),
  AUTOMATION_TRIP_SECRET: randomBytes(32).toString('hex'),
  AUTOMATION_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  TRIP_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  FINANCE_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  TRAVEL_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  EXPORT_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  GATEWAY_CSRF_KEY: randomBytes(32).toString('hex'),
};

const password = 'Long-local-trip-test-password-42!';
const bearer = (user) => ({ authorization: `Bearer ${user.access}` });
const tripBody = (name, clientRequestId = randomUUID()) => ({
  name,
  description: `${name} description`,
  start_at: new Date(Date.now() + 86_400_000).toISOString(),
  end_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  timezone: 'Asia/Ho_Chi_Minh',
  client_request_id: clientRequestId,
});

async function account(label, role = 'USER') {
  const emailLabel = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const email = `${emailLabel}-${randomUUID()}@example.test`;
  const registered = await request(
    '/api/v1/auth/register',
    'POST',
    {
      email,
      password,
      full_name: label,
    },
    { 'x-client-type': 'mobile' },
  );
  assert.equal(registered.status, 202);
  const row = (await query('identity', 'SELECT id FROM users WHERE email=$1', [email]))[0];
  if (role !== 'USER')
    await query('identity', 'UPDATE users SET system_role=$2 WHERE id=$1', [row.id, role]);
  const loggedIn = await request(
    '/api/v1/auth/login',
    'POST',
    { email, password },
    {
      'x-client-type': 'mobile',
    },
  );
  assert.equal(loggedIn.status, 200);
  return { id: row.id, access: loggedIn.body.data.access_token, email };
}

async function main() {
  await mkdir(resolve(root, '.cache'), { recursive: true });
  directory = await mkdtemp(resolve(root, '.cache', 'trip-test-'));
  infra = parseEnv(
    (await readFile(resolve(root, '.env.example'), 'utf8')).replace(/change-me-[\w-]+/g, () =>
      randomBytes(24).toString('hex'),
    ),
  );
  for (const key of [
    'POSTGRES_PORT',
    'RABBITMQ_PORT',
    'RABBITMQ_MANAGEMENT_PORT',
    'MINIO_API_PORT',
    'MINIO_CONSOLE_PORT',
    'MAILPIT_SMTP_PORT',
    'MAILPIT_UI_PORT',
  ])
    infra[key] = String(await port());
  for (const key of Object.keys(ports)) ports[key] = await port();
  await writeFile(
    resolve(directory, '.env'),
    Object.entries(infra)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  created = true;
  await docker([
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '180',
    'postgres',
    ...(invitationMode ? ['rabbitmq', 'mailpit'] : membershipMode ? ['rabbitmq'] : []),
  ]);
  for (const service of [
    'identity',
    'trip',
    ...(invitationMode ? ['automation'] : []),
    ...(membershipMode ? ['finance'] : []),
  ]) {
    await migrate(service, databaseUrl(infra, service), await migrationFiles(service));
  }
  pass('isolated Compose and V001 identity/trip');
  const financePort = await port();
  const financeSecret = randomBytes(32).toString('hex');
  if (membershipMode)
    financeFixture = await startLifecycleFinanceFixture({
      port: financePort,
      secret: financeSecret,
      query,
      transaction,
    });

  await start('identity-service', {
    IDENTITY_PORT: String(ports.identity),
    IDENTITY_GRPC_PORT: String(ports.identityGrpc),
    DATABASE_URL: databaseUrl(infra, 'identity'),
    RABBITMQ_URL: (() => {
      const value = new URL(`amqp://127.0.0.1:${infra.RABBITMQ_PORT}`);
      value.username = infra.RABBITMQ_DEFAULT_USER;
      value.password = infra.RABBITMQ_DEFAULT_PASS;
      return value.href;
    })(),
    MINIO_ENDPOINT: `127.0.0.1:${infra.MINIO_API_PORT}`,
    MINIO_ACCESS_KEY: infra.MINIO_ROOT_USER,
    MINIO_SECRET_KEY: infra.MINIO_ROOT_PASSWORD,
    IDENTITY_LINK_BASE_URL: `http://127.0.0.1:${ports.gateway}`,
    IDENTITY_ACCESS_PRIVATE_KEY: secrets.IDENTITY_ACCESS_PRIVATE_KEY,
    IDENTITY_ACCESS_PUBLIC_KEY: secrets.IDENTITY_ACCESS_PUBLIC_KEY,
    IDENTITY_TOKEN_KEY: secrets.IDENTITY_TOKEN_KEY,
    GATEWAY_IDENTITY_SECRET: secrets.GATEWAY_IDENTITY_SECRET,
    AUTOMATION_IDENTITY_SECRET: secrets.AUTOMATION_IDENTITY_SECRET,
    TRIP_IDENTITY_SECRET: secrets.TRIP_IDENTITY_SECRET,
    FINANCE_IDENTITY_SECRET: secrets.FINANCE_IDENTITY_SECRET,
    TRAVEL_IDENTITY_SECRET: secrets.TRAVEL_IDENTITY_SECRET,
    EXPORT_IDENTITY_SECRET: secrets.EXPORT_IDENTITY_SECRET,
  });
  const tripValues = {
    ...(membershipMode
      ? {
          FINANCE_GRPC_TARGET: `127.0.0.1:${financePort}`,
          TRIP_FINANCE_SECRET: financeSecret,
          TRIP_MEMBERSHIP_LIFECYCLE_ENABLED: 'true',
        }
      : {}),
    TZ: 'America/Los_Angeles',
    TRIP_PORT: String(ports.trip),
    TRIP_GRPC_PORT: String(ports.tripGrpc),
    TRIP_INVITATION_TOKEN_KEY: randomBytes(32).toString('hex'),
    TRIP_INVITATION_LINK_BASE_URL: `http://127.0.0.1:${ports.gateway}`,
    IDENTITY_GRPC_TARGET: `127.0.0.1:${ports.identityGrpc}`,
    TRIP_IDENTITY_SECRET: secrets.TRIP_IDENTITY_SECRET,
    TRIP_OUTBOX_ENABLED: invitationMode ? 'true' : 'false',
    RABBITMQ_URL: brokerUrl(),
    DATABASE_URL: databaseUrl(infra, 'trip'),
    GATEWAY_TRIP_SECRET: secrets.GATEWAY_TRIP_SECRET,
    FINANCE_TRIP_SECRET: secrets.FINANCE_TRIP_SECRET,
    TRAVEL_TRIP_SECRET: secrets.TRAVEL_TRIP_SECRET,
    AUTOMATION_TRIP_SECRET: secrets.AUTOMATION_TRIP_SECRET,
  };
  let tripProcess = await start('trip-workspace-service', tripValues);
  await start('api-gateway', {
    GATEWAY_PORT: String(ports.gateway),
    IDENTITY_HTTP_URL: `http://127.0.0.1:${ports.identity}`,
    IDENTITY_GRPC_TARGET: `127.0.0.1:${ports.identityGrpc}`,
    TRIP_HTTP_URL: `http://127.0.0.1:${ports.trip}`,
    TRIP_GRPC_TARGET: `127.0.0.1:${ports.tripGrpc}`,
    GATEWAY_IDENTITY_SECRET: secrets.GATEWAY_IDENTITY_SECRET,
    GATEWAY_TRIP_SECRET: secrets.GATEWAY_TRIP_SECRET,
    GATEWAY_CSRF_KEY: secrets.GATEWAY_CSRF_KEY,
    WEB_ORIGIN: `http://127.0.0.1:${ports.gateway}`,
  });
  assert.equal((await fetch(`http://127.0.0.1:${ports.gateway}/health/ready`)).status, 200);
  pass('Gateway, Identity and Trip are ready');
  if (membershipMode) {
    await runMembershipTests({
      request,
      query,
      transaction,
      account,
      bearer,
      waitFor,
      pass,
      ports,
      secrets,
      tripBody,
      financeFixture,
      brokerUrl,
      databaseUrl: databaseUrl(infra, 'trip'),
      financePort,
      financeSecret,
      whileTripStopped: async (work) => {
        // Only the child created by this isolated harness, never a dev service.
        tripProcess.kill('SIGKILL');
        await waitFor(() => tripProcess.exitCode !== null || tripProcess.signalCode !== null);
        try {
          return await work();
        } finally {
          tripProcess = await start('trip-workspace-service', tripValues);
        }
      },
    });
    console.log(
      `PASS trip:members:test completed ${checks} groups (Finance protocol fixture, NOT Finance E2E).`,
    );
    return;
  }
  if (invitationMode) {
    const automationPort = await port();
    await start('automation-service', {
      AUTOMATION_PORT: String(automationPort),
      DATABASE_URL: databaseUrl(infra, 'automation'),
      IDENTITY_GRPC_TARGET: `127.0.0.1:${ports.identityGrpc}`,
      AUTOMATION_IDENTITY_SECRET: secrets.AUTOMATION_IDENTITY_SECRET,
      TRIP_GRPC_TARGET: `127.0.0.1:${ports.tripGrpc}`,
      AUTOMATION_TRIP_SECRET: secrets.AUTOMATION_TRIP_SECRET,
      RABBITMQ_URL: brokerUrl(),
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: infra.MAILPIT_SMTP_PORT,
    });
    await runInvitationTests({
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
      startService: (service) => startTestService(project, service),
      brokerUrl,
      automationPort,
    });
    console.log(`PASS trip:invitations:test completed ${checks} groups.`);
    return;
  }

  const unauthorizedTripClient = new TripClient(
    `127.0.0.1:${ports.tripGrpc}`,
    randomBytes(32).toString('hex'),
  );
  try {
    await assert.rejects(
      unauthorizedTripClient.listTrips({ actor_user_id: randomUUID(), limit: 20 }, randomUUID()),
      (error) => error?.code === 7,
    );
  } finally {
    unauthorizedTripClient.close();
  }
  pass('Trip gRPC rejects an invalid service secret');

  const owner = await account('Trip Owner');
  const member = await account('Trip Member');
  const departing = await account('Trip Departing Member');
  const outsider = await account('Trip Outsider');
  const admin = await account('Trip Admin', 'ADMIN');
  assert.equal((await request('/api/v1/me', 'GET', undefined, bearer(owner))).status, 200);
  pass('Identity routes remain reachable through Gateway');

  for (const [stage, table] of [
    ['membership', 'trip_members'],
    ['audit', 'trip_audit_logs'],
    ['receipt', 'trip_operations'],
  ]) {
    const functionName = `test_fail_trip_${stage}`;
    await query(
      'trip',
      `
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional ${stage} rollback'; END $$;
      CREATE TRIGGER ${functionName} BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
    `,
    );
    const failedName = `Rollback ${stage} ${randomUUID()}`;
    const failedInput = tripBody(failedName);
    try {
      const failed = await request('/api/v1/trips', 'POST', failedInput, bearer(owner));
      assert.equal(failed.status, 503);
      const residue = (
        await query(
          'trip',
          `SELECT
             (SELECT count(*)::int FROM trips WHERE name=$1) AS trips,
             (SELECT count(*)::int FROM trip_members WHERE user_id=$2) AS members,
             (SELECT count(*)::int FROM trip_audit_logs WHERE correlation_id=$3) AS audits,
             (SELECT count(*)::int FROM trip_operations WHERE operation_id=$4) AS receipts`,
          [failedName, owner.id, failed.body.meta.correlation_id, failedInput.client_request_id],
        )
      )[0];
      assert.deepEqual(residue, { trips: 0, members: 0, audits: 0, receipts: 0 });
    } finally {
      await query(
        'trip',
        `
        DROP TRIGGER ${functionName} ON ${table};
        DROP FUNCTION ${functionName}()
      `,
      );
    }
  }
  pass('membership, audit and receipt failures each roll back the complete create transaction');

  const createId = randomUUID();
  const createInput = tripBody('Core Access', createId);
  const createHeaders = { ...bearer(owner), 'idempotency-key': createId };
  const creates = await Promise.all([
    request('/api/v1/trips', 'POST', createInput, createHeaders),
    request('/api/v1/trips', 'POST', createInput, createHeaders),
  ]);
  assert.deepEqual(
    creates.map((item) => item.status),
    [201, 201],
  );
  const trip = creates[0].body.data;
  assert.equal(trip.current_membership.role, 'OWNER');
  assert.deepEqual(trip.permissions, { can_read: true, can_update: true });
  const aggregate = (
    await query(
      'trip',
      `
    SELECT
      (SELECT count(*)::int FROM trips WHERE id=$1) AS trips,
      (SELECT count(*)::int FROM trip_members WHERE trip_id=$1 AND role='OWNER' AND left_at IS NULL) AS owners,
      (SELECT count(*)::int FROM trip_operations WHERE operation_id=$2 AND state='SUCCEEDED') AS receipts,
      (SELECT count(*)::int FROM trip_audit_logs WHERE trip_id=$1) AS audits
  `,
      [trip.id, createId],
    )
  )[0];
  assert.deepEqual(aggregate, { trips: 1, owners: 1, receipts: 1, audits: 1 });
  const sequentialReplay = await request('/api/v1/trips', 'POST', createInput, createHeaders);
  assert.equal(sequentialReplay.status, 201);
  assert.equal(sequentialReplay.body.data.id, trip.id);
  const createAuditCorrelation = (
    await query('trip', 'SELECT correlation_id FROM trip_audit_logs WHERE trip_id=$1', [trip.id])
  )[0].correlation_id;
  assert(creates.some((item) => item.body.meta.correlation_id === createAuditCorrelation));
  pass('parallel create commits one Trip, one Owner, one receipt and one audit');

  const mismatchedHeader = await request('/api/v1/trips', 'POST', tripBody('Mismatch'), {
    ...bearer(owner),
    'idempotency-key': randomUUID(),
  });
  assert.equal(mismatchedHeader.status, 400);
  const changedCreate = await request(
    '/api/v1/trips',
    'POST',
    {
      ...createInput,
      name: 'Different intent',
    },
    createHeaders,
  );
  assert.equal(changedCreate.status, 409);
  assert.equal(changedCreate.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const otherActorCreate = await request('/api/v1/trips', 'POST', createInput, {
    ...bearer(outsider),
    'idempotency-key': createId,
  });
  assert.equal(otherActorCreate.status, 409);
  pass('create rejects mismatched and cross-actor idempotency reuse');

  await transaction('trip', async (client) => {
    await client.query(
      `INSERT INTO trip_members(trip_id,user_id,role,joined_at)
       VALUES($1,$2,'MEMBER',now()),($1,$3,'MEMBER',now())`,
      [trip.id, member.id, departing.id],
    );
    await client.query('UPDATE trips SET membership_revision=membership_revision+2 WHERE id=$1', [
      trip.id,
    ]);
  });
  assert.equal(
    (await request(`/api/v1/trips/${trip.id}`, 'GET', undefined, bearer(owner))).status,
    200,
  );
  assert.equal(
    (await request(`/api/v1/trips/${trip.id}`, 'GET', undefined, bearer(member))).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/v1/trips/${trip.id}`, 'GET', undefined, {
        ...bearer(outsider),
        'x-user-id': owner.id,
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(`/api/v1/trips/${trip.id}`, 'GET', undefined, bearer(admin))).status,
    404,
  );
  const memberPage = await request('/api/v1/trips?limit=20', 'GET', undefined, bearer(member));
  assert.equal(memberPage.status, 200);
  assert(memberPage.body.data.items.some((item) => item.id === trip.id));
  const outsiderPage = await request('/api/v1/trips?limit=20', 'GET', undefined, bearer(outsider));
  assert.equal(outsiderPage.status, 200);
  assert(!outsiderPage.body.data.items.some((item) => item.id === trip.id));
  pass('Owner and Member can read while outsider, forged header and Admin cannot');

  const patchInput = {
    name: 'Core Access Updated',
    description: null,
    public_description: 'Public summary',
    expected_plan_version: trip.plan_version,
    expected_export_revision: trip.export_revision,
  };
  assert.equal(
    (await request(`/api/v1/trips/${trip.id}`, 'PATCH', patchInput, bearer(owner))).status,
    400,
  );
  const memberPatch = await request(`/api/v1/trips/${trip.id}`, 'PATCH', patchInput, {
    ...bearer(member),
    'idempotency-key': randomUUID(),
  });
  assert.equal(memberPatch.status, 403);
  assert.equal(memberPatch.body.error.code, 'PERMISSION_DENIED');
  const extraField = await request(
    `/api/v1/trips/${trip.id}`,
    'PATCH',
    {
      ...patchInput,
      timezone: 'UTC',
    },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assert.equal(extraField.status, 400);
  const crossCommandReuse = await request(`/api/v1/trips/${trip.id}`, 'PATCH', patchInput, {
    ...bearer(owner),
    'idempotency-key': createId,
  });
  assert.equal(crossCommandReuse.status, 409);
  assert.equal(crossCommandReuse.body.error.code, 'IDEMPOTENCY_CONFLICT');
  pass('PATCH enforces idempotency, strict fields and Owner-only access');

  const firstPatchKey = randomUUID();
  const secondPatchKey = randomUUID();
  const raced = await Promise.all([
    request(`/api/v1/trips/${trip.id}`, 'PATCH', patchInput, {
      ...bearer(owner),
      'idempotency-key': firstPatchKey,
    }),
    request(
      `/api/v1/trips/${trip.id}`,
      'PATCH',
      { ...patchInput, name: 'Concurrent loser' },
      {
        ...bearer(owner),
        'idempotency-key': secondPatchKey,
      },
    ),
  ]);
  assert.deepEqual(raced.map((item) => item.status).sort(), [200, 409]);
  const winner = raced.find((item) => item.status === 200);
  const winnerKey = winner === raced[0] ? firstPatchKey : secondPatchKey;
  const winnerBody = winner === raced[0] ? patchInput : { ...patchInput, name: 'Concurrent loser' };
  assert.equal(winner.body.data.export_revision, trip.export_revision + 1);
  assert.equal(winner.body.data.plan_version, trip.plan_version);
  const loser = raced.find((item) => item.status === 409);
  assert.equal(loser.body.error.code, 'VERSION_CONFLICT');
  assert.equal(loser.body.error.details.export_revision, winner.body.data.export_revision);
  const replay = await request(`/api/v1/trips/${trip.id}`, 'PATCH', winnerBody, {
    ...bearer(owner),
    'idempotency-key': winnerKey,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.export_revision, winner.body.data.export_revision);
  assert.equal(
    (
      await query(
        'trip',
        "SELECT count(*)::int AS n FROM trip_audit_logs WHERE trip_id=$1 AND action='TRIP_METADATA_UPDATED'",
        [trip.id],
      )
    )[0].n,
    1,
  );
  const changedReplay = await request(
    `/api/v1/trips/${trip.id}`,
    'PATCH',
    {
      ...winnerBody,
      public_description: 'Different retry',
    },
    { ...bearer(owner), 'idempotency-key': winnerKey },
  );
  assert.equal(changedReplay.status, 409);
  assert.equal(changedReplay.body.error.code, 'IDEMPOTENCY_CONFLICT');
  pass('concurrent update has one winner and stable idempotent replay');

  const noChangeAudit = (
    await query('trip', 'SELECT count(*)::int AS n FROM trip_audit_logs WHERE trip_id=$1', [
      trip.id,
    ])
  )[0].n;
  const noChange = await request(
    `/api/v1/trips/${trip.id}`,
    'PATCH',
    {
      name: winner.body.data.name,
      expected_plan_version: winner.body.data.plan_version,
      expected_export_revision: winner.body.data.export_revision,
    },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assert.equal(noChange.status, 200);
  assert.equal(noChange.body.data.export_revision, winner.body.data.export_revision);
  assert.equal(
    (
      await query('trip', 'SELECT count(*)::int AS n FROM trip_audit_logs WHERE trip_id=$1', [
        trip.id,
      ])
    )[0].n,
    noChangeAudit,
  );
  pass('no-op update keeps revision and audit count unchanged');

  const membershipRows = await query(
    'trip',
    `SELECT id,user_id FROM trip_members
     WHERE trip_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id`,
    [trip.id, [member.id, departing.id]],
  );
  const memberMembershipId = membershipRows.find((row) => row.user_id === member.id).id;
  const departingMembershipId = membershipRows.find((row) => row.user_id === departing.id).id;

  const otherTripKey = randomUUID();
  const otherTripResponse = await request(
    '/api/v1/trips',
    'POST',
    tripBody('Other Trip', otherTripKey),
    { ...bearer(outsider), 'idempotency-key': otherTripKey },
  );
  assert.equal(otherTripResponse.status, 201);
  const otherTrip = otherTripResponse.body.data;
  const crossTripMembership = (
    await query(
      'trip',
      `INSERT INTO trip_members(trip_id,user_id,role,joined_at)
       VALUES($1,$2,'MEMBER',now()) RETURNING id`,
      [otherTrip.id, admin.id],
    )
  )[0];
  await query('trip', 'UPDATE trips SET membership_revision=membership_revision+1 WHERE id=$1', [
    otherTrip.id,
  ]);

  const tripTarget = `127.0.0.1:${ports.tripGrpc}`;
  const accessClient = new TripAccessClient(tripTarget, 'Travel', secrets.TRAVEL_TRIP_SECRET);
  const invalidSecretAccess = new TripAccessClient(
    tripTarget,
    'Travel',
    randomBytes(32).toString('hex'),
  );
  const invalidCallerAccess = new TripAccessClient(
    tripTarget,
    'ApiGateway',
    secrets.GATEWAY_TRIP_SECRET,
  );
  try {
    const ownerContext = (
      await accessClient.getAccessContext({
        trip_id: trip.id,
        user_id: owner.id,
        action: 'PLAN_EDIT',
      })
    ).context;
    assert.equal(ownerContext.allowed, true);
    assert.equal(ownerContext.can_read_trip, true);
    assert.equal(ownerContext.can_update_trip_metadata, true);
    assert.equal(ownerContext.can_edit_plan, true);
    assert.deepEqual(ownerContext.permissions.sort(), [
      'PLAN_EDIT',
      'PLAN_POLICY_UPDATE',
      'TRIP_UPDATE_METADATA',
      'TRIP_VIEW',
    ]);
    assert(!('command_payload' in ownerContext));
    assert(!('outcome' in ownerContext));

    const memberContext = (
      await accessClient.getAccessContext({
        trip_id: trip.id,
        user_id: member.id,
        action: 'PLAN_EDIT',
      })
    ).context;
    assert.equal(memberContext.allowed, false);
    assert.equal(memberContext.can_read_trip, true);
    assert.equal(memberContext.can_edit_plan, false);
    for (const user of [outsider, admin]) {
      await assert.rejects(
        accessClient.getAccessContext({
          trip_id: trip.id,
          user_id: user.id,
          action: 'TRIP_VIEW',
        }),
        (error) => error?.code === 5,
      );
    }
    await assert.rejects(
      accessClient.getAccessContext({
        trip_id: trip.id,
        user_id: member.id,
        action: 'UNKNOWN_ACTION',
      }),
      (error) => error?.code === 3,
    );
    await assert.rejects(
      invalidSecretAccess.getAccessContext({
        trip_id: trip.id,
        user_id: owner.id,
        action: 'TRIP_VIEW',
      }),
      (error) => error?.code === 7,
    );
    await assert.rejects(
      invalidCallerAccess.getAccessContext({
        trip_id: trip.id,
        user_id: owner.id,
        action: 'TRIP_VIEW',
      }),
      (error) => error?.code === 7,
    );
    await assert.rejects(
      accessClient.getAccessContext(
        { trip_id: trip.id, user_id: owner.id, action: 'TRIP_VIEW' },
        'invalid-correlation-id',
      ),
      (error) => error?.code === 7,
    );
  } finally {
    accessClient.close();
    invalidSecretAccess.close();
    invalidCallerAccess.close();
  }
  pass('GetAccessContext enforces current membership, action, projection and service identity');

  const policyPath = `/api/v1/trips/${trip.id}/plan-policy`;
  const putPolicy = (actor, body, key = randomUUID(), headers = {}) =>
    request(policyPath, 'PUT', body, {
      ...bearer(actor),
      'idempotency-key': key,
      ...headers,
    });
  const currentPolicyState = async () =>
    (
      await query(
        'trip',
        `SELECT t.plan_edit_policy,t.membership_revision,t.plan_version,t.export_revision,
           ARRAY(SELECT pe.trip_member_id FROM trip_plan_editors pe
                 WHERE pe.trip_id=t.id ORDER BY pe.trip_member_id) AS editor_member_ids,
           (SELECT count(*)::int FROM trip_audit_logs a
            WHERE a.trip_id=t.id AND a.action='PLAN_ACCESS_UPDATED') AS policy_audits,
           (SELECT count(*)::int FROM trip_operations o
            WHERE o.trip_id=t.id AND o.operation_type='UPDATE_PLAN_POLICY') AS policy_receipts
         FROM trips t WHERE t.id=$1`,
        [trip.id],
      )
    )[0];
  const policyBody = (policy, editorIds, expectedRevision) => ({
    policy,
    editor_member_ids: editorIds,
    expected_membership_revision: expectedRevision,
  });

  let policyState = await currentPolicyState();
  assert.equal(
    (
      await request(
        policyPath,
        'PUT',
        policyBody('OWNER_ONLY', [], policyState.membership_revision),
        bearer(owner),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await putPolicy(
        member,
        policyBody('ALL_MEMBERS', [], policyState.membership_revision),
        randomUUID(),
        { 'x-user-id': owner.id },
      )
    ).status,
    403,
  );
  assert.equal(
    (await putPolicy(admin, policyBody('ALL_MEMBERS', [], policyState.membership_revision))).status,
    404,
  );
  assert.equal(
    (
      await putPolicy(owner, {
        ...policyBody('ALL_MEMBERS', [], policyState.membership_revision),
        actor_user_id: owner.id,
      })
    ).status,
    400,
  );
  for (const invalidEditorId of [
    randomUUID(),
    crossTripMembership.id,
    trip.current_membership.id,
  ]) {
    const invalidGrant = await putPolicy(
      owner,
      policyBody('SELECTED_MEMBERS', [invalidEditorId], policyState.membership_revision),
    );
    assert.equal(invalidGrant.status, 400);
  }
  pass('Plan policy route requires idempotency, Owner session and same-Trip active Member IDs');

  const beforePolicyVersions = await currentPolicyState();
  const selectCorrelationKey = randomUUID();
  const selected = await putPolicy(
    owner,
    policyBody(
      'SELECTED_MEMBERS',
      [departingMembershipId, memberMembershipId],
      policyState.membership_revision,
    ),
    selectCorrelationKey,
  );
  assert.equal(selected.status, 200);
  assert.deepEqual(
    selected.body.data.editor_member_ids,
    [memberMembershipId, departingMembershipId].sort(),
  );
  assert.equal(selected.body.data.membership_revision, policyState.membership_revision + 1);
  policyState = await currentPolicyState();
  assert.equal(policyState.plan_version, beforePolicyVersions.plan_version);
  assert.equal(policyState.export_revision, beforePolicyVersions.export_revision);
  const selectedAudit = (
    await query(
      'trip',
      `SELECT correlation_id FROM trip_audit_logs
       WHERE trip_id=$1 AND action='PLAN_ACCESS_UPDATED' ORDER BY occurred_at DESC,id DESC LIMIT 1`,
      [trip.id],
    )
  )[0];
  assert.equal(selectedAudit.correlation_id, selected.body.meta.correlation_id);

  const selectedAccess = new TripAccessClient(tripTarget, 'Travel', secrets.TRAVEL_TRIP_SECRET);
  try {
    for (const user of [member, departing]) {
      const context = (
        await selectedAccess.getAccessContext({
          trip_id: trip.id,
          user_id: user.id,
          action: 'PLAN_EDIT',
        })
      ).context;
      assert.equal(context.allowed, true);
      assert.equal(context.can_edit_plan, true);
    }
  } finally {
    selectedAccess.close();
  }

  await transaction('trip', async (client) => {
    await client.query("UPDATE trip_members SET left_at=now(),left_reason='TEST' WHERE id=$1", [
      departingMembershipId,
    ]);
    await client.query('UPDATE trips SET membership_revision=membership_revision+1 WHERE id=$1', [
      trip.id,
    ]);
  });
  policyState = await currentPolicyState();
  const departedAccess = new TripAccessClient(tripTarget, 'Travel', secrets.TRAVEL_TRIP_SECRET);
  try {
    await assert.rejects(
      departedAccess.getAccessContext({
        trip_id: trip.id,
        user_id: departing.id,
        action: 'PLAN_EDIT',
      }),
      (error) => error?.code === 5,
    );
  } finally {
    departedAccess.close();
  }
  const departedGrant = await putPolicy(
    owner,
    policyBody('SELECTED_MEMBERS', [departingMembershipId], policyState.membership_revision),
  );
  assert.equal(departedGrant.status, 400);
  assert.deepEqual(await currentPolicyState(), policyState);
  const preserveEditors = await putPolicy(
    owner,
    policyBody('OWNER_ONLY', [], policyState.membership_revision),
  );
  assert.equal(preserveEditors.status, 200);
  assert.deepEqual(preserveEditors.body.data.editor_member_ids, [memberMembershipId]);
  assert.equal((await currentPolicyState()).editor_member_ids.length, 2);
  policyState = await currentPolicyState();
  const cleanStaleEditor = await putPolicy(
    owner,
    policyBody('SELECTED_MEMBERS', [memberMembershipId], policyState.membership_revision),
  );
  assert.equal(cleanStaleEditor.status, 200);
  assert.deepEqual((await currentPolicyState()).editor_member_ids, [memberMembershipId]);
  pass(
    'departed editor loses access immediately while saved assignments stay inert until replaced',
  );

  policyState = await currentPolicyState();
  const revoked = await putPolicy(
    owner,
    policyBody('SELECTED_MEMBERS', [], policyState.membership_revision),
  );
  assert.equal(revoked.status, 200);
  const revokedAccess = new TripAccessClient(tripTarget, 'Travel', secrets.TRAVEL_TRIP_SECRET);
  try {
    assert.equal(
      (
        await revokedAccess.getAccessContext({
          trip_id: trip.id,
          user_id: member.id,
          action: 'PLAN_EDIT',
        })
      ).context.can_edit_plan,
      false,
    );
  } finally {
    revokedAccess.close();
  }
  policyState = await currentPolicyState();
  const granted = await putPolicy(
    owner,
    policyBody('SELECTED_MEMBERS', [memberMembershipId], policyState.membership_revision),
  );
  assert.equal(granted.status, 200);
  policyState = await currentPolicyState();
  const allMembers = await putPolicy(
    owner,
    policyBody('ALL_MEMBERS', [], policyState.membership_revision),
  );
  assert.equal(allMembers.status, 200);
  assert.deepEqual(allMembers.body.data.editor_member_ids, [memberMembershipId]);
  const allAccess = new TripAccessClient(tripTarget, 'Travel', secrets.TRAVEL_TRIP_SECRET);
  try {
    assert.equal(
      (
        await allAccess.getAccessContext({
          trip_id: trip.id,
          user_id: member.id,
          action: 'PLAN_EDIT',
        })
      ).context.can_edit_plan,
      true,
    );
  } finally {
    allAccess.close();
  }
  policyState = await currentPolicyState();
  const ownerOnly = await putPolicy(
    owner,
    policyBody('OWNER_ONLY', [], policyState.membership_revision),
  );
  assert.equal(ownerOnly.status, 200);
  assert.deepEqual(ownerOnly.body.data.editor_member_ids, [memberMembershipId]);
  pass('Owner can grant, revoke and switch all three Plan policies with immediate effect');

  // Force the Plan check to start before revocation commits and verify it really
  // waits on the revoker, rather than relying on timing or a sequential read.
  policyState = await currentPolicyState();
  const beforeRaceGrant = await putPolicy(
    owner,
    policyBody('SELECTED_MEMBERS', [memberMembershipId], policyState.membership_revision),
  );
  assert.equal(beforeRaceGrant.status, 200);
  const revoker = new pg.Client({ connectionString: databaseUrl(infra, 'trip') });
  const planWriter = new pg.Client({ connectionString: databaseUrl(infra, 'trip') });
  let pendingPlanCheck;
  try {
    await revoker.connect();
    await planWriter.connect();
    await revoker.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await planWriter.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await planWriter.query("SET LOCAL statement_timeout = '15s'");
    const revokerPid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const writerPid = (await planWriter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const policyService = new TripPlanAccessService({ withTransaction: (work) => work(revoker) });
    const revokedPolicy = await policyService.updatePolicy({
      operationId: randomUUID(),
      actorUserId: owner.id,
      tripId: trip.id,
      policy: 'SELECTED_MEMBERS',
      editorMemberIds: [],
      expectedMembershipRevision: beforeRaceGrant.body.data.membership_revision,
      correlationId: randomUUID(),
    });
    let planCheckSettled = false;
    pendingPlanCheck = new TripAccessService({})
      .getContextForUpdate(planWriter, {
        tripId: trip.id,
        userId: member.id,
        action: 'PLAN_EDIT',
      })
      .then(
        (context) => {
          planCheckSettled = true;
          return { context };
        },
        (error) => {
          planCheckSettled = true;
          return { error };
        },
      );
    await waitFor(
      async () =>
        (
          await query('trip', 'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked', [
            revokerPid,
            writerPid,
          ])
        )[0].blocked,
      10_000,
    );
    assert.equal(planCheckSettled, false, 'Plan check must be waiting for the revocation lock');
    await revoker.query('COMMIT');
    const checked = await pendingPlanCheck;
    if (checked.error) throw checked.error;
    assert.equal(checked.context.revisions.membership_revision, revokedPolicy.membership_revision);
    assert.equal(checked.context.can_edit_plan, false);
    assert.equal(checked.context.allowed, false);
    assert.deepEqual(revokedPolicy.editor_member_ids, []);
    await planWriter.query('COMMIT');
  } finally {
    await revoker.query('ROLLBACK').catch(() => {});
    if (pendingPlanCheck) await pendingPlanCheck;
    await planWriter.query('ROLLBACK').catch(() => {});
    await Promise.all([revoker.end(), planWriter.end()]);
  }
  pass(
    'Plan write check waiting behind editor revocation uses the post-commit permission snapshot',
  );

  policyState = await currentPolicyState();
  const noOpKey = randomUUID();
  const noOp = await putPolicy(
    owner,
    policyBody(policyState.plan_edit_policy, [], policyState.membership_revision),
    noOpKey,
  );
  assert.equal(noOp.status, 200);
  const afterNoOpPolicy = await currentPolicyState();
  assert.equal(afterNoOpPolicy.membership_revision, policyState.membership_revision);
  assert.equal(afterNoOpPolicy.policy_audits, policyState.policy_audits);
  assert.equal(
    (
      await query(
        'trip',
        `SELECT count(*)::int AS n FROM trip_operations
         WHERE operation_id=$1 AND operation_type='UPDATE_PLAN_POLICY' AND state='SUCCEEDED'`,
        [noOpKey],
      )
    )[0].n,
    1,
  );
  const stalePolicy = await putPolicy(
    owner,
    policyBody('ALL_MEMBERS', [], Math.max(1, policyState.membership_revision - 1)),
  );
  assert.equal(stalePolicy.status, 409);
  assert.equal(stalePolicy.body.error.code, 'VERSION_CONFLICT');
  assert.equal(stalePolicy.body.error.details.membership_revision, policyState.membership_revision);
  pass(
    'Plan policy no-op writes one receipt without audit or revision and stale revisions conflict',
  );

  policyState = await currentPolicyState();
  const racePolicies = ['OWNER_ONLY', 'SELECTED_MEMBERS', 'ALL_MEMBERS'].filter(
    (policy) => policy !== policyState.plan_edit_policy,
  );
  const racedPolicies = await Promise.all(
    racePolicies.map((policy) =>
      putPolicy(
        owner,
        policyBody(
          policy,
          policy === 'SELECTED_MEMBERS' ? [memberMembershipId] : [],
          policyState.membership_revision,
        ),
      ),
    ),
  );
  assert.deepEqual(racedPolicies.map((item) => item.status).sort(), [200, 409]);
  const raceLoser = racedPolicies.find((item) => item.status === 409);
  assert.equal(raceLoser.body.error.code, 'VERSION_CONFLICT');
  policyState = await currentPolicyState();

  const duplicateTarget = ['OWNER_ONLY', 'SELECTED_MEMBERS', 'ALL_MEMBERS'].find(
    (policy) => policy !== policyState.plan_edit_policy,
  );
  const duplicateBody = policyBody(
    duplicateTarget,
    duplicateTarget === 'SELECTED_MEMBERS' ? [memberMembershipId] : [],
    policyState.membership_revision,
  );
  const duplicateKey = randomUUID();
  const auditBeforeDuplicate = policyState.policy_audits;
  const duplicateRequests = await Promise.all([
    putPolicy(owner, duplicateBody, duplicateKey),
    putPolicy(owner, duplicateBody, duplicateKey),
  ]);
  assert.deepEqual(
    duplicateRequests.map((item) => item.status),
    [200, 200],
  );
  policyState = await currentPolicyState();
  assert.equal(policyState.policy_audits, auditBeforeDuplicate + 1);
  assert.equal(
    (
      await query('trip', 'SELECT count(*)::int AS n FROM trip_operations WHERE operation_id=$1', [
        duplicateKey,
      ])
    )[0].n,
    1,
  );
  const changedDuplicate = await putPolicy(
    owner,
    policyBody(
      policyState.plan_edit_policy === 'OWNER_ONLY' ? 'ALL_MEMBERS' : 'OWNER_ONLY',
      [],
      policyState.membership_revision,
    ),
    duplicateKey,
  );
  assert.equal(changedDuplicate.status, 409);
  assert.equal(changedDuplicate.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const replayByMember = await putPolicy(member, duplicateBody, duplicateKey);
  assert.equal(replayByMember.status, 403);
  pass('policy races have one winner and receipt replay cannot bypass current Owner permission');

  const laterPolicy = policyState.plan_edit_policy === 'OWNER_ONLY' ? 'ALL_MEMBERS' : 'OWNER_ONLY';
  const laterMutation = await putPolicy(
    owner,
    policyBody(laterPolicy, [], policyState.membership_revision),
  );
  assert.equal(laterMutation.status, 200);
  const beforeHistoricalReplay = await currentPolicyState();
  const historicalReplay = await putPolicy(owner, duplicateBody, duplicateKey);
  assert.equal(historicalReplay.status, 200);
  assert.deepEqual(historicalReplay.body.data, duplicateRequests[0].body.data);
  assert.notEqual(
    historicalReplay.body.data.membership_revision,
    laterMutation.body.data.membership_revision,
  );
  assert.deepEqual(await currentPolicyState(), beforeHistoricalReplay);
  pass(
    'policy replay after a later mutation returns its original response without changing current state',
  );

  for (const [stage, table] of [
    ['audit', 'trip_audit_logs'],
    ['receipt', 'trip_operations'],
  ]) {
    const beforeFailure = await currentPolicyState();
    const targetPolicy =
      beforeFailure.plan_edit_policy === 'OWNER_ONLY' ? 'ALL_MEMBERS' : 'OWNER_ONLY';
    const functionName = `test_fail_plan_${stage}`;
    await query(
      'trip',
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'intentional policy ${stage} rollback'; END $$;
       CREATE TRIGGER ${functionName} BEFORE INSERT ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    const failedOperation = randomUUID();
    try {
      const failed = await putPolicy(
        owner,
        policyBody(targetPolicy, [], beforeFailure.membership_revision),
        failedOperation,
      );
      assert.equal(failed.status, 503);
      const afterFailure = await currentPolicyState();
      assert.deepEqual(afterFailure, beforeFailure);
      assert.equal(
        (
          await query(
            'trip',
            'SELECT count(*)::int AS n FROM trip_operations WHERE operation_id=$1',
            [failedOperation],
          )
        )[0].n,
        0,
      );
    } finally {
      await query(
        'trip',
        `DROP TRIGGER ${functionName} ON ${table}; DROP FUNCTION ${functionName}()`,
      );
    }
  }
  pass('Plan policy audit and receipt failures roll back policy, editors and revision');

  const pageSeed = [];
  for (const name of ['Page A', 'Page B']) {
    const key = randomUUID();
    const createdTrip = await request('/api/v1/trips', 'POST', tripBody(name, key), {
      ...bearer(owner),
      'idempotency-key': key,
    });
    assert.equal(createdTrip.status, 201);
    pageSeed.push(createdTrip.body.data);
  }
  const firstPage = await request('/api/v1/trips?limit=1', 'GET', undefined, bearer(owner));
  assert.equal(firstPage.status, 200);
  assert(firstPage.body.data.next_cursor);
  const secondPage = await request(
    `/api/v1/trips?limit=1&cursor=${encodeURIComponent(firstPage.body.data.next_cursor)}`,
    'GET',
    undefined,
    bearer(owner),
  );
  assert.equal(secondPage.status, 200);
  assert.notEqual(firstPage.body.data.items[0].id, secondPage.body.data.items[0].id);
  assert.equal(
    (
      await request(
        `/api/v1/trips?limit=1&lifecycle=ARCHIVED&cursor=${encodeURIComponent(firstPage.body.data.next_cursor)}`,
        'GET',
        undefined,
        bearer(owner),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `/api/v1/trips?limit=1&cursor=${encodeURIComponent(firstPage.body.data.next_cursor)}`,
        'GET',
        undefined,
        bearer(outsider),
      )
    ).status,
    400,
  );
  pass('cursor is stable and bound to actor plus filter');

  await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [trip.id]);
  assert.equal(
    (await request(`/api/v1/trips/${trip.id}`, 'GET', undefined, bearer(owner))).body.data
      .lifecycle,
    'ARCHIVED',
  );
  const lifecycleAccess = new TripAccessClient(tripTarget, 'Finance', secrets.FINANCE_TRIP_SECRET);
  try {
    const archivedContext = (
      await lifecycleAccess.getAccessContext({
        trip_id: trip.id,
        user_id: owner.id,
        action: 'PLAN_EDIT',
      })
    ).context;
    assert.equal(archivedContext.trip_state, 2);
    assert.equal(archivedContext.can_read_trip, true);
    assert.equal(archivedContext.can_edit_plan, false);
    assert.equal(archivedContext.can_update_trip_metadata, false);
  } finally {
    lifecycleAccess.close();
  }
  assert(
    !(await request('/api/v1/trips', 'GET', undefined, bearer(owner))).body.data.items.some(
      (item) => item.id === trip.id,
    ),
  );
  assert(
    (
      await request('/api/v1/trips?lifecycle=ARCHIVED', 'GET', undefined, bearer(owner))
    ).body.data.items.some((item) => item.id === trip.id),
  );
  const archivedPatch = await request(
    `/api/v1/trips/${trip.id}`,
    'PATCH',
    {
      name: 'Archived edit',
      expected_plan_version: winner.body.data.plan_version,
      expected_export_revision: winner.body.data.export_revision,
    },
    { ...bearer(owner), 'idempotency-key': randomUUID() },
  );
  assert.equal(archivedPatch.status, 409);
  assert.equal(archivedPatch.body.error.code, 'STATE_CONFLICT');

  const deleted = pageSeed[0];
  await query('trip', 'UPDATE trips SET deleted_at=now() WHERE id=$1', [deleted.id]);
  assert.equal(
    (await request(`/api/v1/trips/${deleted.id}`, 'GET', undefined, bearer(owner))).status,
    404,
  );
  const deletedAccess = new TripAccessClient(
    tripTarget,
    'Automation',
    secrets.AUTOMATION_TRIP_SECRET,
  );
  try {
    await assert.rejects(
      deletedAccess.getAccessContext({
        trip_id: deleted.id,
        user_id: owner.id,
        action: 'TRIP_VIEW',
      }),
      (error) => error?.code === 5,
    );
  } finally {
    deletedAccess.close();
  }
  pass('archived Trips are read-only in access context and deleted Trips are hidden');

  await transaction('trip', async (client) => {
    await client.query(
      "UPDATE trip_members SET role='MEMBER' WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL",
      [trip.id, owner.id],
    );
    await client.query(
      "UPDATE trip_members SET role='OWNER' WHERE trip_id=$1 AND user_id=$2 AND left_at IS NULL",
      [trip.id, member.id],
    );
    await client.query('UPDATE trips SET membership_revision=membership_revision+1 WHERE id=$1', [
      trip.id,
    ]);
  });
  assert.equal(
    (
      await request(`/api/v1/trips/${trip.id}`, 'PATCH', winnerBody, {
        ...bearer(owner),
        'idempotency-key': winnerKey,
      })
    ).status,
    403,
  );
  await query(
    'trip',
    "UPDATE trip_members SET left_at=now(),left_reason='TEST' WHERE trip_id=$1 AND user_id=$2",
    [trip.id, owner.id],
  );
  assert.equal(
    (await request(`/api/v1/trips/${trip.id}`, 'GET', undefined, bearer(owner))).status,
    404,
  );
  assert.equal(
    (await request(`/api/v1/trips/${trip.id}`, 'GET', undefined, bearer(member))).status,
    200,
  );
  pass('receipt replay cannot restore revoked Owner or departed membership access');

  // Reuse authenticated actors so this suite stays below Identity's registration rate limit.
  await runPlanScenarios({
    request,
    query,
    transaction,
    account,
    bearer,
    tripBody,
    pass,
    users: { owner, member, editor: admin, outsider },
  });

  await query('identity', 'UPDATE refresh_sessions SET revoked_at=now() WHERE user_id=$1', [
    outsider.id,
  ]);
  assert.equal((await request('/api/v1/trips', 'GET', undefined, bearer(outsider))).status, 401);
  pass('revoked Identity session fails before Trip authorization');

  await adminQuery('ALTER ROLE trip_app NOLOGIN');
  try {
    await adminQuery(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='trip_db' AND usename='trip_app'",
    );
    assert.equal((await request('/api/v1/trips', 'GET', undefined, bearer(member))).status, 503);
  } finally {
    await adminQuery('ALTER ROLE trip_app LOGIN');
  }
  await waitFor(
    async () =>
      (await request(`/api/v1/trips/${trip.id}`, 'GET', undefined, bearer(member))).status === 200,
  );
  pass('trip_db connection outage fails closed and recovers');

  await stop(tripProcess);
  assert.equal((await fetch(`http://127.0.0.1:${ports.gateway}/health/ready`)).status, 503);
  const outageKey = randomUUID();
  const outage = await request('/api/v1/trips', 'POST', tripBody('Outage', outageKey), {
    ...bearer(member),
    'idempotency-key': outageKey,
  });
  assert.equal(outage.status, 503);
  assert.equal(outage.body.error.retryable, true);
  assert.match(outage.body.error.message, /cùng khóa chống lặp/i);
  pass('Trip outage fails closed and lowers Gateway readiness');

  const forbidden = [
    owner.access,
    member.access,
    outsider.access,
    admin.access,
    ...Object.values(secrets),
    infra.POSTGRES_PASSWORD,
  ];
  for (const child of children) {
    for (const value of forbidden)
      assert(!child.output.includes(value), `${child.appName} logged a secret`);
  }
  pass('application output does not contain tokens or configured secrets');
  console.log(`PASS trip:test completed ${checks} groups.`);
}

try {
  await main();
} catch (error) {
  console.error('FAIL trip:test:', error instanceof Error ? error.stack : error);
  for (const child of children) {
    if (child.output) console.error(`${child.appName} output:\n${child.output.slice(-4000)}`);
  }
  process.exitCode = 1;
} finally {
  await financeFixture?.close();
  for (const child of children) {
    try {
      await stop(child);
    } catch {
      if (child.exitCode === null) child.kill();
    }
  }
  if (created) {
    try {
      await docker(['down', '--volumes', '--remove-orphans']);
    } catch (error) {
      console.error('trip:test cleanup failed:', error instanceof Error ? error.message : error);
    }
  }
  if (directory) {
    const cleanupPath = resolve(directory);
    const cachePath = resolve(root, '.cache');
    if (
      dirname(cleanupPath) !== cachePath ||
      !cleanupPath.startsWith(resolve(cachePath, 'trip-test-'))
    ) {
      throw new Error('Unsafe Trip test cleanup path');
    }
    await rm(cleanupPath, { recursive: true, force: true });
  }
}
