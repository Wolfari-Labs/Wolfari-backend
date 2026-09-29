import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { root, apps, appEnvironment, databaseUrl } from './config.mjs';
import { compose } from './infrastructure.mjs';
import { migrate, migrationFiles } from './migrations.mjs';

const require = createRequire(import.meta.url);
const amqp = require('amqplib');
const { IdentityClient } = require('../packages/contracts/dist/identity-client.js');
const identityRequire = createRequire(resolve(root, 'apps/identity-service/package.json'));
const sharp = identityRequire('sharp');
const project = `wolfari-identity-test-${randomBytes(5).toString('hex')}`;
const children = [];
let directory;
let infra;
let created = false;
let checkCount = 0;
const pass = text => { checkCount++; console.log(`PASS ${text}`); };

async function port() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const value = server.address().port;
  await new Promise(resolvePromise => server.close(resolvePromise));
  return value;
}

async function waitFor(work, timeout = 20000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { const value = await work(); if (value) return value; }
    catch (error) { last = error; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  throw last ?? new Error('TEST_TIMEOUT');
}

function docker(args) { return compose(infra, args, { project, envFile: resolve(directory, '.env') }); }
function brokerUrl() {
  const value = new URL(`amqp://127.0.0.1:${infra.RABBITMQ_PORT}`);
  value.username = infra.RABBITMQ_DEFAULT_USER;
  value.password = infra.RABBITMQ_DEFAULT_PASS;
  return value.href;
}

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${ports.gateway}${path}`, {
    method, headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const type = response.headers.get('content-type') ?? '';
  const payload = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body: payload, cookie: response.headers.get('set-cookie'), headers: response.headers };
}

async function mail(recipient, subjectFragment, afterCount = 0) {
  return waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${infra.MAILPIT_UI_PORT}/api/v1/messages`)).json();
    const matches = list.messages?.filter(item => item.To?.some(address => address.Address === recipient) && item.Subject.includes(subjectFragment)) ?? [];
    if (matches.length <= afterCount) return null;
    const message = matches.sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    if (!message) return null;
    return (await (await fetch(`http://127.0.0.1:${infra.MAILPIT_UI_PORT}/api/v1/message/${message.ID}`)).json()).Text;
  }, 30000);
}

function tokenFromMail(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  assert(match, 'email has a local link');
  return new URL(match[0]).searchParams.get('token');
}

const ports = { gateway: 0, identity: 0, automation: 0, grpc: 0 };
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const secrets = {
  IDENTITY_ACCESS_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  IDENTITY_ACCESS_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  IDENTITY_TOKEN_KEY: randomBytes(32).toString('hex'),
  GATEWAY_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  AUTOMATION_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  TRIP_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  FINANCE_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  TRAVEL_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  EXPORT_IDENTITY_SECRET: randomBytes(32).toString('hex'),
  GATEWAY_CSRF_KEY: randomBytes(32).toString('hex'),
};

async function start(name, values) {
  const app = apps.find(item => item.name === name);
  const child = fork(resolve(root, 'apps', name, 'dist/main.js'), [], {
    cwd: root, env: appEnvironment(app, { NODE_ENV: 'test', ...values }), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  child.appName = name;
  child.output = '';
  child.stdout.on('data', data => { child.output = (child.output + String(data)).slice(-100000); });
  child.stderr.on('data', data => { child.lastError = String(data).slice(-1000); child.output = (child.output + String(data)).slice(-100000); });
  children.push(child);
  const portValue = Number(values[app.portKey]);
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`${name} exited: ${child.lastError ?? child.exitCode}`);
    return (await fetch(`http://127.0.0.1:${portValue}/health/live`, { signal: AbortSignal.timeout(1000) })).ok;
  });
}

async function query(service, sql, params = []) {
  const client = new pg.Client({ connectionString: databaseUrl(infra, service) });
  await client.connect();
  try { return (await client.query(sql, params)).rows; } finally { await client.end(); }
}

async function main() {
  await mkdir(resolve(root, '.cache'), { recursive: true });
  directory = await mkdtemp(resolve(root, '.cache', 'identity-test-'));
  infra = parseEnv((await readFile(resolve(root, '.env.example'), 'utf8')).replace(/change-me-[\w-]+/g, () => randomBytes(24).toString('hex')));
  for (const key of ['POSTGRES_PORT', 'RABBITMQ_PORT', 'RABBITMQ_MANAGEMENT_PORT', 'MINIO_API_PORT', 'MINIO_CONSOLE_PORT', 'MAILPIT_SMTP_PORT', 'MAILPIT_UI_PORT']) infra[key] = String(await port());
  for (const key of Object.keys(ports)) ports[key] = await port();
  await writeFile(resolve(directory, '.env'), Object.entries(infra).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  created = true;
  await docker(['up', '-d', '--wait', '--wait-timeout', '180']);
  for (const service of ['identity', 'automation']) await migrate(service, databaseUrl(infra, service), await migrationFiles(service));
  pass('isolated Compose and V001 identity/automation');

  const identityBase = {
    IDENTITY_PORT: String(ports.identity), IDENTITY_GRPC_PORT: String(ports.grpc), DATABASE_URL: databaseUrl(infra, 'identity'),
    RABBITMQ_URL: brokerUrl(), MINIO_ENDPOINT: `127.0.0.1:${infra.MINIO_API_PORT}`,
    MINIO_ACCESS_KEY: infra.MINIO_ROOT_USER, MINIO_SECRET_KEY: infra.MINIO_ROOT_PASSWORD,
    IDENTITY_LINK_BASE_URL: `http://127.0.0.1:${ports.gateway}`, ...secrets,
  };
  await start('identity-service', identityBase);
  await start('automation-service', {
    AUTOMATION_PORT: String(ports.automation), DATABASE_URL: databaseUrl(infra, 'automation'),
    IDENTITY_GRPC_TARGET: `127.0.0.1:${ports.grpc}`, AUTOMATION_IDENTITY_SECRET: secrets.AUTOMATION_IDENTITY_SECRET,
    RABBITMQ_URL: brokerUrl(), SMTP_HOST: '127.0.0.1', SMTP_PORT: infra.MAILPIT_SMTP_PORT,
  });
  await start('api-gateway', {
    GATEWAY_PORT: String(ports.gateway), IDENTITY_HTTP_URL: `http://127.0.0.1:${ports.identity}`,
    IDENTITY_GRPC_TARGET: `127.0.0.1:${ports.grpc}`, GATEWAY_IDENTITY_SECRET: secrets.GATEWAY_IDENTITY_SECRET,
    GATEWAY_CSRF_KEY: secrets.GATEWAY_CSRF_KEY, WEB_ORIGIN: `http://127.0.0.1:${ports.gateway}`,
  });
  pass('Gateway, Identity, Automation ready');

  const email = `identity-${randomUUID()}@example.test`;
  const originalPassword = 'Long-local-test-password-42!';
  const registerBody = { email: `  ${email.toUpperCase()}  `, password: originalPassword, full_name: 'Identity Test' };
  const registrations = await Promise.all([request('/api/v1/auth/register', 'POST', registerBody), request('/api/v1/auth/register', 'POST', registerBody)]);
  assert.deepEqual(registrations.map(item => item.status), [202, 202]);
  assert.equal((await query('identity', 'SELECT count(*)::int AS n FROM users WHERE email=$1', [email]))[0].n, 1);
  const unverified = await request('/api/v1/auth/login', 'POST', { email, password: originalPassword }, { 'x-client-type': 'mobile' });
  assert.equal(unverified.status, 200);
  assert.equal(unverified.body.data.profile.email_verified_at, null);
  const verifyText = await mail(email, 'Xác minh');
  const verifyToken = tokenFromMail(verifyText);
  assert(verifyToken);
  const tokenPage = await request(`/api/v1/auth/local/verify?token=${verifyToken}`);
  assert.equal(tokenPage.status, 200);
  assert.equal((await request('/api/v1/auth/email-verifications', 'POST', {}, { 'x-client-type': 'mobile', authorization: `Bearer ${unverified.body.data.access_token}` })).status, 202);
  const replacementToken = tokenFromMail(await mail(email, 'Xác minh', 1));
  assert.equal((await request('/api/v1/auth/email-verifications/confirm', 'POST', { token: verifyToken })).status, 400);
  assert.equal((await request('/api/v1/auth/email-verifications/confirm', 'POST', { token: replacementToken })).status, 200);
  assert.equal((await request('/api/v1/auth/email-verifications/confirm', 'POST', { token: replacementToken })).status, 400);
  pass('parallel register, unverified login, resend revokes old link, scanner-safe GET');

  const web = await request('/api/v1/auth/login', 'POST', { email, password: originalPassword });
  assert.equal(web.status, 200);
  assert(web.cookie?.includes('HttpOnly'));
  assert.equal(web.body.data.refresh_token, undefined);
  const access = web.body.data.access_token;
  const cookie = web.cookie.split(';')[0];
  const auth = { authorization: `Bearer ${access}` };
  assert.equal((await request('/api/v1/me', 'GET', undefined, auth)).status, 200);
  assert.equal((await request('/api/v1/auth/refresh', 'POST', {}, { cookie, origin: `http://127.0.0.1:${ports.gateway}` })).status, 403);
  const csrf = await request('/api/v1/auth/csrf', 'GET', undefined, { cookie });
  assert.equal(csrf.status, 200);
  const rotated = await request('/api/v1/auth/refresh', 'POST', {}, { cookie, origin: `http://127.0.0.1:${ports.gateway}`, 'x-csrf-token': csrf.body.data.csrf_token });
  assert.equal(rotated.status, 200);
  assert(rotated.cookie && rotated.body.data.refresh_token === undefined);
  assert.equal((await request('/api/v1/auth/refresh', 'POST', {}, { cookie, origin: `http://127.0.0.1:${ports.gateway}`, 'x-csrf-token': csrf.body.data.csrf_token })).status, 401);
  assert.equal((await request('/api/v1/me', 'GET', undefined, { authorization: `Bearer ${rotated.body.data.access_token}` })).status, 401);
  pass('web cookie, CSRF and refresh reuse revokes family');

  const raced = unverified;
  const raceResults = await Promise.all([0, 1].map(() => request('/api/v1/auth/refresh', 'POST', { refresh_token: raced.body.data.refresh_token }, { 'x-client-type': 'mobile' })));
  assert.deepEqual(raceResults.map(item => item.status).sort(), [200, 401]);
  const raceAccess = raceResults.find(item => item.status === 200).body.data.access_token;
  assert.equal((await request('/api/v1/me', 'GET', undefined, { 'x-client-type': 'mobile', authorization: `Bearer ${raceAccess}` })).status, 401);
  pass('concurrent refresh serializes rotation and reuse revokes family');

  const mobileHeaders = { 'x-client-type': 'mobile' };
  const mobile = await request('/api/v1/auth/login', 'POST', { email, password: originalPassword }, mobileHeaders);
  assert.equal(mobile.status, 200);
  assert(typeof mobile.body.data.refresh_token === 'string');
  const mobileRefresh = await request('/api/v1/auth/refresh', 'POST', { refresh_token: mobile.body.data.refresh_token }, mobileHeaders);
  assert.equal(mobileRefresh.status, 200);
  assert.equal((await request('/api/v1/auth/refresh', 'POST', { refresh_token: mobile.body.data.refresh_token }, { ...mobileHeaders, cookie })).status, 400);
  const mobileAuth = { ...mobileHeaders, authorization: `Bearer ${mobileRefresh.body.data.access_token}` };
  const profile = await request('/api/v1/me', 'GET', undefined, mobileAuth);
  assert.equal(profile.status, 200);
  assert.equal((await request('/api/v1/me', 'PATCH', { expected_version: profile.body.data.version + 1, full_name: 'Changed' }, mobileAuth)).status, 409);
  const updated = await request('/api/v1/me', 'PATCH', { expected_version: profile.body.data.version, full_name: 'Changed' }, mobileAuth);
  assert.equal(updated.status, 200);
  pass('mobile refresh, conflicting version and profile update');

  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const upload = new FormData(); upload.set('file', new Blob([image], { type: 'image/png' }), 'avatar.png');
  const avatar = await request('/api/v1/me/avatar', 'POST', upload, mobileAuth);
  assert.equal(avatar.status, 201);
  const avatarProfile = await request('/api/v1/me', 'PATCH', { expected_version: updated.body.data.version, avatar_object_key: avatar.body.data.object_key }, mobileAuth);
  assert.equal(avatarProfile.status, 200);
  assert.equal((await request('/api/v1/me/avatar', 'GET', undefined, mobileAuth)).status, 200);
  const fakeUpload = new FormData(); fakeUpload.set('file', new Blob(['not-png'], { type: 'image/png' }), 'fake.png');
  assert.equal((await request('/api/v1/me/avatar', 'POST', fakeUpload, mobileAuth)).status, 400);
  const anonymous = await fetch(`http://127.0.0.1:${infra.MINIO_API_PORT}/wolfari-identity-avatars/${avatar.body.data.object_key}`);
  assert.equal(anonymous.status, 403);
  pass('private avatar upload, attach, read, forged image and anonymous access');

  const client = new IdentityClient(`127.0.0.1:${ports.grpc}`, 'Trip', secrets.TRIP_IDENTITY_SECRET);
  const badClient = new IdentityClient(`127.0.0.1:${ports.grpc}`, 'Trip', 'wrong-secret');
  try {
    const profiles = await client.getProfiles({ user_ids: [profile.body.data.id] });
    assert.equal(profiles.profiles[0].display_name, 'Changed');
    await assert.rejects(badClient.getProfiles({ user_ids: [profile.body.data.id] }));
  } finally { client.close(); badClient.close(); }
  assert.equal((await query('identity', "SELECT count(*)::int AS n FROM outbox_events WHERE event_type='AccountEmailRequested' AND status='PUBLISHED'"))[0].n, 2);
  assert.equal((await query('automation', "SELECT count(*)::int AS n FROM notification_deliveries WHERE status='SENT'"))[0].n, 2);
  pass('three-RPC server caller check, confirmed outbox, deduped delivery');

  const source = (await query('identity', "SELECT * FROM outbox_events WHERE event_type='AccountEmailRequested' ORDER BY created_at LIMIT 1"))[0];
  const replay = {
    event_id: source.event_id, event_type: source.event_type, schema_version: source.schema_version,
    occurred_at: source.occurred_at.toISOString(), producer: source.producer,
    aggregate_type: source.aggregate_type, aggregate_id: source.aggregate_id,
    aggregate_version: source.aggregate_version, correlation_id: source.correlation_id,
    causation_id: source.causation_id, operation_id: source.operation_id, trip_id: source.trip_id,
    actor_user_id: source.actor_user_id, system_actor: source.system_actor, payload: source.payload,
  };
  const rabbit = await amqp.connect(brokerUrl());
  const channel = await rabbit.createConfirmChannel();
  try {
    const publish = (event, routingKey = 'AccountEmailRequested') => new Promise((resolvePromise, reject) => channel.publish('wolfari.events.v1', routingKey,
      Buffer.from(JSON.stringify(event)), { persistent: true, mandatory: true, messageId: event.event_id, contentType: 'application/json' },
      error => error ? reject(error) : resolvePromise()));
    await publish(replay);
    await publish({ ...replay, event_id: randomUUID(), schema_version: 99 });
    await publish({ ...replay, event_id: randomUUID(), event_type: 'UnknownAccountEvent' });
    await waitFor(async () => (await channel.checkQueue('wolfari.automation.account-email.v1.dlq')).messageCount >= 2);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    assert.equal((await query('automation', "SELECT count(*)::int AS n FROM notification_deliveries WHERE status='SENT'"))[0].n, 2);
    assert.equal((await query('automation', "SELECT count(*)::int AS n FROM inbox_events WHERE event_type='AccountEmailRequested'"))[0].n, 2);
  } finally { await channel.close(); await rabbit.close(); }
  pass('duplicate event is idempotent; unknown event/version reaches DLQ');

  const otherEmail = `other-${randomUUID()}@example.test`;
  assert.equal((await request('/api/v1/auth/register', 'POST', { email: otherEmail, password: originalPassword, full_name: 'Other user' })).status, 202);
  const other = await request('/api/v1/auth/login', 'POST', { email: otherEmail, password: originalPassword }, mobileHeaders);
  assert.equal(other.status, 200);
  const otherAuth = { ...mobileHeaders, authorization: `Bearer ${other.body.data.access_token}` };
  const otherSessions = await request('/api/v1/me/sessions', 'GET', undefined, otherAuth);
  assert.equal(otherSessions.status, 200);
  const otherSessionId = otherSessions.body.data.items[0].id;
  assert.equal((await request(`/api/v1/me/sessions/${otherSessionId}`, 'DELETE', undefined, mobileAuth)).status, 404);
  assert.equal((await request('/api/v1/me', 'PATCH', { expected_version: avatarProfile.body.data.version, avatar_object_key: `users/${other.body.data.profile.id}/avatars/${randomUUID()}.png` }, mobileAuth)).status, 400);
  const ownSessions = await request('/api/v1/me/sessions', 'GET', undefined, mobileAuth);
  assert.equal(ownSessions.status, 200);
  assert.equal((await request('/api/v1/auth/logout', 'POST', { session_id: ownSessions.body.data.items[0].id }, mobileAuth)).status, 204);
  assert.equal((await request('/api/v1/me', 'GET', undefined, mobileAuth)).status, 401);
  pass('Self-only session/avatar, mobile logout revokes access immediately');

  const otherTokenId = (await query('identity', "SELECT id FROM one_time_tokens WHERE user_id=$1 AND purpose='VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1", [other.body.data.profile.id]))[0].id;
  const otherNotification = await waitFor(async () => (await query('automation', 'SELECT id FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [other.body.data.profile.id]))[0]?.id);
  const replayId = randomUUID();
  await query('automation', `INSERT INTO notification_deliveries(id,notification_id,channel,delivery_key,status,attempt_count,last_error,private_context)
    VALUES($1,$2,'EMAIL',$3,'FAILED',6,'DELIVERY_FAILED',$4)`, [replayId, otherNotification, `operator-replay:${replayId}`, JSON.stringify({ token_id: otherTokenId })]);
  const replayEnv = resolve(directory, 'automation-replay.env');
  await writeFile(replayEnv, `NODE_ENV=test\nDATABASE_URL=${databaseUrl(infra, 'automation')}\n`, { mode: 0o600 });
  const replayResult = await new Promise((resolvePromise, reject) => {
    const command = spawn(process.execPath, [resolve(root, 'scripts/identity-replay-email.mjs'), '--delivery-id', replayId, '--reason', 'TEST-REPLAY'],
      { cwd: root, env: { ...process.env, WOLFARI_REPLAY_ENV_FILE: replayEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    command.stdout.on('data', chunk => { output += String(chunk); });
    command.stderr.on('data', chunk => { output += String(chunk); });
    command.once('error', reject);
    command.once('exit', code => resolvePromise({ code, output }));
  });
  assert.equal(replayResult.code, 0, replayResult.output);
  await waitFor(async () => (await query('automation', "SELECT count(*)::int AS n FROM notification_deliveries WHERE id=$1 AND status='SENT'", [replayId]))[0].n === 1);
  pass('controlled operator replay of a failed SMTP delivery');

  const beforeReset = await request('/api/v1/auth/login', 'POST', { email, password: originalPassword }, mobileHeaders);
  assert.equal(beforeReset.status, 200);
  const beforeResetAuth = { ...mobileHeaders, authorization: `Bearer ${beforeReset.body.data.access_token}` };

  const unknown = await request('/api/v1/auth/password-reset-requests', 'POST', { email: `missing-${randomUUID()}@example.test` });
  const known = await request('/api/v1/auth/password-reset-requests', 'POST', { email });
  assert.equal(unknown.status, 202); assert.equal(known.status, 202);
  assert.equal(unknown.body.data.message_code, known.body.data.message_code);
  const resetToken = tokenFromMail(await mail(email, 'Đặt lại'));
  const newPassword = 'Different-long-password-43!';
  assert.equal((await request('/api/v1/auth/password-resets', 'POST', { token: resetToken, new_password: newPassword })).status, 200);
  assert.equal((await request('/api/v1/auth/password-resets', 'POST', { token: resetToken, new_password: newPassword })).status, 400);
  assert.equal((await request('/api/v1/auth/login', 'POST', { email, password: originalPassword }, mobileHeaders)).status, 401);
  const changed = await request('/api/v1/auth/login', 'POST', { email, password: newPassword }, mobileHeaders);
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/v1/me', 'GET', undefined, beforeResetAuth)).status, 401);
  pass('generic reset response, single-use reset, old session/password revoked');

  const changeAuth = { ...mobileHeaders, authorization: `Bearer ${changed.body.data.access_token}` };
  const finalPassword = 'Third-long-password-value-44!';
  assert.equal((await request('/api/v1/me/password-change', 'POST', { current_password: newPassword, new_password: finalPassword }, changeAuth)).status, 200);
  assert.equal((await request('/api/v1/me', 'GET', undefined, changeAuth)).status, 401);
  assert.equal((await request('/api/v1/auth/login', 'POST', { email, password: newPassword }, mobileHeaders)).status, 401);
  const finalLogin = await request('/api/v1/auth/login', 'POST', { email, password: finalPassword }, mobileHeaders);
  assert.equal(finalLogin.status, 200);
  const finalAuth = { ...mobileHeaders, authorization: `Bearer ${finalLogin.body.data.access_token}` };
  await query('identity', "UPDATE users SET status='LOCKED' WHERE email=$1", [email]);
  assert.equal((await request('/api/v1/me', 'GET', undefined, finalAuth)).status, 401);
  assert.equal((await request('/api/v1/auth/login', 'POST', { email, password: finalPassword }, mobileHeaders)).status, 401);
  pass('password change revokes sessions; locked account blocks new requests');

  const outageEmail = `outage-${randomUUID()}@example.test`;
  await docker(['stop', 'rabbitmq']);
  assert.equal((await fetch(`http://127.0.0.1:${ports.gateway}/health/ready`)).status, 200);
  assert.equal((await request('/api/v1/auth/register', 'POST', { email: outageEmail, password: originalPassword, full_name: 'Outage user' })).status, 202);
  assert.equal((await query('identity', "SELECT count(*)::int AS n FROM outbox_events WHERE status='PENDING' AND aggregate_id=(SELECT id FROM users WHERE email=$1)", [outageEmail]))[0].n, 1);
  await docker(['up', '-d', '--wait', '--wait-timeout', '120', 'rabbitmq']);
  assert(tokenFromMail(await mail(outageEmail, 'Xác minh')));
  const outageUserId = (await query('identity', 'SELECT id FROM users WHERE email=$1', [outageEmail]))[0].id;
  assert.equal((await query('automation', "SELECT count(*)::int AS n FROM inbox_events WHERE event_type='AccountEmailRequested' AND aggregate_id=$1", [outageUserId]))[0].n, 1);
  pass('broker outage preserves outbox and recovery delivers email');

  await docker(['stop', 'mailpit']);
  assert.equal((await fetch(`http://127.0.0.1:${ports.gateway}/health/ready`)).status, 200);
  assert.equal((await request('/api/v1/auth/password-reset-requests', 'POST', { email: outageEmail })).status, 202);
  const resetId = (await query('identity', "SELECT id FROM one_time_tokens WHERE user_id=$1 AND purpose='RESET_PASSWORD' ORDER BY created_at DESC LIMIT 1", [outageUserId]))[0].id;
  await waitFor(async () => (await query('automation', "SELECT count(*)::int AS n FROM notification_deliveries WHERE status='PENDING' AND attempt_count>=1 AND private_context->>'token_id'=$1", [resetId]))[0].n > 0);
  await docker(['up', '-d', '--wait', '--wait-timeout', '120', 'mailpit']);
  await query('automation', "UPDATE notification_deliveries SET next_attempt_at=now() WHERE status='PENDING' AND private_context->>'token_id'=$1", [resetId]);
  assert(tokenFromMail(await mail(outageEmail, 'Đặt lại')));
  pass('SMTP outage leaves retryable delivery and recovery sends it');

  await docker(['stop', 'rabbitmq']);
  assert.equal((await request('/api/v1/auth/password-reset-requests', 'POST', { email: outageEmail })).status, 202);
  const expiredId = (await query('identity', "SELECT id FROM one_time_tokens WHERE user_id=$1 AND purpose='RESET_PASSWORD' ORDER BY created_at DESC LIMIT 1", [outageUserId]))[0].id;
  await query('identity', "UPDATE one_time_tokens SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1", [expiredId]);
  await docker(['up', '-d', '--wait', '--wait-timeout', '120', 'rabbitmq']);
  await waitFor(async () => (await query('automation', "SELECT count(*)::int AS n FROM notification_deliveries WHERE delivery_key=$1 AND status='FAILED' AND last_error='TOKEN_INVALID'", [`account-email:${expiredId}`]))[0].n === 1);
  assert.equal((await query('identity', 'SELECT delivery_token_ciphertext IS NULL AS cleared FROM one_time_tokens WHERE id=$1', [expiredId]))[0].cleared, true);
  const mailbox = await (await fetch(`http://127.0.0.1:${infra.MAILPIT_UI_PORT}/api/v1/messages`)).json();
  assert.equal(mailbox.messages.filter(item => item.To?.some(address => address.Address === outageEmail) && item.Subject.includes('Đặt lại')).length, 1);
  pass('expired token is discarded before SMTP; no extra reset email');

  const readiness = await fetch(`http://127.0.0.1:${ports.gateway}/health/ready`);
  assert.equal(readiness.status, 200);
  assert.equal((await request(`/api/v1/me/sessions/${otherSessionId}`, 'DELETE', undefined, otherAuth)).status, 204);
  assert.equal((await request('/api/v1/me', 'GET', undefined, otherAuth)).status, 401);
  pass('Self session deletion revokes access immediately');
  const forbidden = [originalPassword, newPassword, finalPassword, verifyToken, replacementToken, resetToken];
  for (const child of children) for (const secret of forbidden) assert(!child.output.includes(secret), `${child.appName} logged a sensitive value`);
  pass('service logs omit password and one-time token values');
  const identityProcess = children.find(child => child.appName === 'identity-service');
  identityProcess.send('shutdown');
  await waitFor(async () => identityProcess.exitCode !== null);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${ports.gateway}/health/ready`)).status === 503);
  assert.equal((await request('/api/v1/me', 'GET', undefined, otherAuth)).status, 503);
  pass(`Gateway readiness and protected route fail closed when Identity stops; ${checkCount + 1} integration groups`);
}

try { await main(); }
catch (error) { console.error('FAIL identity:test:', error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
finally {
  for (const child of children.reverse()) {
    if (child.connected) child.send('shutdown');
    await new Promise(resolvePromise => { if (child.exitCode !== null) return resolvePromise(); child.once('exit', resolvePromise); setTimeout(() => { child.kill(); resolvePromise(); }, 8000).unref(); });
  }
  if (created) await docker(['down', '--volumes', '--remove-orphans']).catch(error => console.error('WARN test cleanup:', String(error).slice(0, 300)));
  if (directory) await rm(directory, { recursive: true, force: true });
}
