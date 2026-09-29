import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { root, services, apps, appEnvironment, databaseUrl } from './config.mjs';
import { compose } from './infrastructure.mjs';
import { migrate, migrationFiles, connectDatabase, history, safeError } from './migrations.mjs';

const require = createRequire(import.meta.url);
const { DatabaseProvider, databaseConfig } = require('../packages/database/dist/index.js');
const project = `wolfari-test-${randomBytes(6).toString('hex')}`;
const children = [];
let checks = 0;
let provider;
let created = false;
let directory;
let env;
let stage = 'setup';
const pass = message => { checks++; console.log(`PASS ${message}`); };
async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function db(service, work) {
  const client = await connectDatabase(service, databaseUrl(env, service));
  try { return await work(client); } finally { await client.end(); }
}
async function waitForDatabase(service, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await db(service, client => client.query('SELECT 1')); return; }
    catch (error) {
      if (['28P01', '42501'].includes(error.code) || error.message === 'WRONG_DATABASE_OR_ROLE') throw error;
      if (Date.now() >= deadline) throw new Error('POSTGRES_RESTART_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
function docker(args) { return compose(env, args, { project, envFile: resolve(directory, '.env') }); }
function dockerDiagnostic(args) {
  return new Promise(resolveResult => {
    const command = ['compose', '--project-name', project, '--env-file', resolve(directory, '.env'),
      '-f', resolve(root, 'infrastructure/docker-compose.yml'), ...args];
    const child = spawn('docker', command, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const append = chunk => { output = (output + chunk.toString()).slice(-16000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill(), 10000);
    child.once('error', error => { clearTimeout(timer); resolveResult({ code: error.code ?? 'ERROR', output }); });
    child.once('close', code => { clearTimeout(timer); resolveResult({ code, output }); });
  });
}
async function reportDockerDiagnostics() {
  if (!created || !directory || !env) return;
  for (const [label, args] of [['containers', ['ps', '--all']], ['postgres logs', ['logs', '--no-color', '--tail=80', 'postgres']]]) {
    const result = await dockerDiagnostic(args);
    let output = result.output;
    for (const [key, value] of Object.entries(env)) {
      if (/(?:PASS|PASSWORD|SECRET|TOKEN|PRIVATE_KEY)/.test(key) && value) output = output.replaceAll(String(value), '[REDACTED]');
    }
    console.error(`db:test Docker ${label} (exit ${result.code}):\n${output || '(no output)'}`);
  }
}
function bootstrapFailureProbe() {
  return new Promise((resolvePromise, reject) => {
    const args = [
      'compose', '--project-name', project, '--env-file', resolve(directory, '.env'),
      '-f', resolve(root, 'infrastructure/docker-compose.yml'), 'exec', '-T', 'postgres',
      'psql', '--set=ON_ERROR_STOP=1', '--username', env.POSTGRES_USER, '--dbname', 'postgres',
    ];
    const child = spawn('docker', args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolvePromise({ code, stdout, stderr }));
    child.stdin.end('SELECT 1/0;\nSELECT 42 AS should_not_run;\n');
  });
}
async function health(app, endpoint, status = 200) {
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${app.testPort}/health/${endpoint}`, { signal: AbortSignal.timeout(3500), headers: { 'x-correlation-id': 'ab814514-965c-443b-ae80-257a6776d89d' } });
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.service, app.name);
  if (endpoint === 'ready') { assert.equal(body.correlation_id, 'ab814514-965c-443b-ae80-257a6776d89d'); assert(Date.now() - started < 3000); }
  return body;
}
async function launchApps() {
  for (const app of apps) app.testPort = await port();
  const grpcPort = await port();
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const secrets = Object.fromEntries(['GATEWAY', 'AUTOMATION', 'TRIP', 'FINANCE', 'TRAVEL', 'EXPORT'].map(caller => [`${caller}_IDENTITY_SECRET`, randomBytes(32).toString('hex')]));
  const gatewayPort = apps.find(app => app.name === 'api-gateway').testPort;
  const identityPort = apps.find(app => app.name === 'identity-service').testPort;
  for (const app of apps) {
    const values = {
      NODE_ENV: 'test', [app.portKey]: String(app.testPort),
      ...(app.service ? { DATABASE_URL: databaseUrl(env, app.service) } : {}),
      ...(app.name === 'identity-service' ? {
        ...secrets, IDENTITY_GRPC_PORT: String(grpcPort),
        IDENTITY_ACCESS_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        IDENTITY_ACCESS_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        IDENTITY_TOKEN_KEY: randomBytes(32).toString('hex'),
        RABBITMQ_URL: 'amqp://127.0.0.1:9', MINIO_ENDPOINT: '127.0.0.1:9',
        MINIO_ACCESS_KEY: 'test', MINIO_SECRET_KEY: 'test',
        IDENTITY_LINK_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
      } : {}),
      ...(app.name === 'automation-service' ? {
        AUTOMATION_IDENTITY_SECRET: secrets.AUTOMATION_IDENTITY_SECRET,
        IDENTITY_GRPC_TARGET: `127.0.0.1:${grpcPort}`, RABBITMQ_URL: 'amqp://127.0.0.1:9',
        SMTP_HOST: '127.0.0.1', SMTP_PORT: '9',
      } : {}),
      ...(app.name === 'api-gateway' ? {
        GATEWAY_IDENTITY_SECRET: secrets.GATEWAY_IDENTITY_SECRET,
        GATEWAY_CSRF_KEY: randomBytes(32).toString('hex'),
        IDENTITY_HTTP_URL: `http://127.0.0.1:${identityPort}`,
        IDENTITY_GRPC_TARGET: `127.0.0.1:${grpcPort}`,
        WEB_ORIGIN: `http://127.0.0.1:${gatewayPort}`,
      } : {}),
    };
    const child = fork(resolve(root, 'apps', app.name, 'dist/main.js'), [], { env: appEnvironment(app, values), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    child.stderr.on('data', () => {});
    children.push(child);
  }
  const deadline = Date.now() + 20000;
  for (const app of apps) {
    while (true) {
      try { await health(app, 'live'); break; }
      catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
    }
  }
}
async function main() {
  await mkdir(resolve(root, '.cache'), { recursive: true });
  directory = await mkdtemp(resolve(root, '.cache', 'db-test-'));
  env = parseEnv((await readFile(resolve(root, '.env.example'), 'utf8')).replace(/change-me-[\w-]+/g, () => randomBytes(24).toString('hex')));
  for (const key of ['POSTGRES_PORT', 'RABBITMQ_PORT', 'RABBITMQ_MANAGEMENT_PORT', 'MINIO_API_PORT', 'MINIO_CONSOLE_PORT']) env[key] = String(await port());
  await writeFile(resolve(directory, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  created = true;
  stage = 'postgres-start';
  await docker(['up', '-d', '--wait', '--wait-timeout', '180', 'postgres']);
  stage = 'bootstrap-error-stop';
  const bootstrapProbe = await bootstrapFailureProbe();
  assert.notEqual(bootstrapProbe.code, 0);
  assert(!bootstrapProbe.stdout.includes('should_not_run'));
  assert.match(bootstrapProbe.stderr, /division by zero/i);
  pass('psql bootstrap dừng ngay và trả mã lỗi khi SQL thất bại');
  stage = 'migrations';
  const files = Object.fromEntries(await Promise.all(services.map(async service => [service, await migrationFiles(service)])));
  await Promise.all([migrate('identity', databaseUrl(env, 'identity'), files.identity), migrate('identity', databaseUrl(env, 'identity'), files.identity)]);
  pass('hai runner đồng thời chỉ áp dụng V001 một lần');
  for (const service of services) {
    await migrate(service, databaseUrl(env, service), files[service]);
    await migrate(service, databaseUrl(env, service), files[service]);
  }
  pass('cài mới và chạy lại cả 5 migration');
  stage = 'schema-and-constraints';
  const counts = [8, 18, 4, 17, 12]; let fks = 0;
  for (const [index, service] of services.entries()) await db(service, async client => {
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, counts[index]);
    fks += (await client.query("SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace")).rows[0].n;
    assert.deepEqual(await history(client, files[service]), ['V001']);
  });
  assert.equal(fks, 46); pass('54 bảng mô hình + 5 lịch sử, 46 FK');
  for (const service of ['identity', 'trip', 'finance']) await db(service, async client => {
    await client.query(await readFile(resolve(root, 'apps', apps.find(a => a.service === service).name, 'tests/database/V001_constraints.sql'), 'utf8'));
  });
  pass('3 fixture constraint hiện có (ROLLBACK)');
  stage = 'database-isolation';
  for (const source of services) for (const target of services.filter(s => s !== source)) {
    const url = new URL(databaseUrl(env, source)); url.pathname = `/${target}_db`;
    const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 2000 });
    try { await assert.rejects(client.connect(), error => error.code === '42501'); } finally { await client.end().catch(() => {}); }
  }
  pass('20/20 kết nối chéo database bị PostgreSQL từ chối');
  await assert.rejects(connectDatabase('identity', databaseUrl(env, 'travel')), /WRONG_DATABASE_OR_ROLE/);
  const wrongPassword = new URL(databaseUrl(env, 'identity')); wrongPassword.password = 'wrong-password';
  await assert.rejects(connectDatabase('identity', wrongPassword.href), error => error.code === '28P01');
  pass('sai database/role và mật khẩu đều bị chặn');
  stage = 'migration-failure-cases';
  await db('travel', async client => {
    await client.query('SELECT pg_advisory_lock(1464814674, 1)');
    try { await assert.rejects(migrate('travel', databaseUrl(env, 'travel'), files.travel, 200), /MIGRATION_LOCK_TIMEOUT/); }
    finally { await client.query('SELECT pg_advisory_unlock(1464814674, 1)'); }
  }); pass('runner timeout khi khóa đang bận');
  await assert.rejects(migrate('travel', databaseUrl(env, 'travel'), [...files.travel, { version: 'V002', sql: "BEGIN; CREATE TABLE rollback_probe(id int); SELECT 1/0; INSERT INTO schema_migrations(version) VALUES('V002'); COMMIT;" }]), error => error.code === '22012');
  await db('travel', async client => {
    assert.equal((await client.query("SELECT to_regclass('public.rollback_probe') AS name")).rows[0].name, null);
    assert.deepEqual(await history(client, files.travel), ['V001']);
    await client.query("INSERT INTO schema_migrations(version) VALUES('V999')");
    try { await assert.rejects(history(client, files.travel), /UNKNOWN_OR_INVALID/); }
    finally { await client.query("DELETE FROM schema_migrations WHERE version='V999'"); }
    await client.query('ALTER TABLE schema_migrations RENAME TO saved_migrations');
    try { await assert.rejects(migrate('travel', databaseUrl(env, 'travel'), files.travel), /UNVERSIONED_SCHEMA/); }
    finally { await client.query('ALTER TABLE saved_migrations RENAME TO schema_migrations'); }
  }); pass('rollback migration lỗi; từ chối lịch sử lạ và schema chưa đánh phiên bản');

  stage = 'database-provider';
  const config = databaseConfig({ DATABASE_URL: databaseUrl(env, 'travel') }, 'travel');
  provider = new DatabaseProvider(new pg.Pool(config), config, 'travel');
  await provider.query('CREATE TABLE provider_probe(value bigint, precise numeric)');
  await provider.withTransaction(client => client.query('INSERT INTO provider_probe VALUES($1,$2)', ['9007199254740993', '12.34']));
  await assert.rejects(provider.withTransaction(async client => { await client.query('INSERT INTO provider_probe VALUES(2,3)'); throw new Error('rollback'); }));
  assert.deepEqual((await provider.query('SELECT * FROM provider_probe')).rows, [{ value: '9007199254740993', precise: '12.34' }]);
  assert.equal(provider.pool.totalCount, provider.pool.idleCount);
  pass('provider commit/rollback, bigint/numeric chính xác, trả connection về pool');
  stage = 'app-startup-readiness';
  await launchApps();
  for (const app of apps.filter(a => a.service)) await health(app, 'ready');
  pass('7 liveness, 5 readiness trên cổng thử nghiệm');
  stage = 'missing-migration-readiness';
  const travel = apps.find(a => a.service === 'travel');
  await db('travel', async client => {
    await client.query('ALTER TABLE schema_migrations RENAME TO saved_migrations');
    try { assert.equal((await health(travel, 'ready', 503)).checks.migrations, 'missing'); }
    finally { await client.query('ALTER TABLE saved_migrations RENAME TO schema_migrations'); }
  }); pass('thiếu migration trả HTTP 503');
  stage = 'paused-database-readiness';
  await docker(['pause', 'postgres']);
  try {
    await Promise.all(Array.from({ length: 10 }, () => health(travel, 'ready', 503)));
    await health(travel, 'live');
  } finally { await docker(['unpause', 'postgres']); }
  pass('DB treo: 10 readiness đồng thời hoàn tất <3 giây, liveness vẫn sống');
  stage = 'database-outage-readiness';
  await provider.onApplicationShutdown(); provider = undefined;
  console.log('db:test: cố ý dừng PostgreSQL để kiểm tra outage/recovery.');
  await docker(['stop', 'postgres']);
  for (const app of apps.filter(a => a.service)) await health(app, 'ready', 503);
  stage = 'database-restart';
  await docker(['start', 'postgres']);
  await waitForDatabase('identity');
  stage = 'database-recovery-readiness';
  for (const app of apps.filter(a => a.service)) await health(app, 'ready');
  await db('travel', async client => {
    assert.equal((await client.query('SELECT count(*)::int AS n FROM provider_probe')).rows[0].n, 1);
    await client.query('DROP TABLE provider_probe');
  }); pass('DB stop/start: 503 → 200, dữ liệu còn nguyên');
  console.log(`PASS ${checks} nhóm kiểm thử database tích hợp.`);
}

try { await main(); }
catch (error) {
  console.error(`FAIL db:test [${stage}]:`, safeError(error), error instanceof assert.AssertionError ? error.message : '');
  await reportDockerDiagnostics();
  process.exitCode = 1;
}
finally {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send('shutdown'); else child.kill();
  })));
  await provider?.onApplicationShutdown();
  // Only destroy the unique project generated by this invocation.
  if (created && /^wolfari-test-[a-f0-9]{12}$/.test(project)) await docker(['down', '--volumes']).catch(() => { console.error(`Không dọn được project thử nghiệm ${project}.`); process.exitCode = 1; });
  if (directory) await rm(directory, { recursive: true, force: true });
}
