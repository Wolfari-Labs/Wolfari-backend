import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes, generateKeyPairSync } from 'node:crypto';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const services = ['identity', 'trip', 'travel', 'finance', 'automation'];
export const appNames = {
  identity: 'identity-service', trip: 'trip-workspace-service',
  travel: 'travel-intelligence-service', finance: 'finance-service',
  automation: 'automation-service',
};
export const apps = [
  { name: 'api-gateway', portKey: 'GATEWAY_PORT', port: 3000 },
  ...services.map((service, i) => ({ name: appNames[service], service, portKey: `${service.toUpperCase()}_PORT`, port: 3101 + i })),
  { name: 'export-worker', portKey: 'EXPORT_WORKER_PORT', port: 3106 },
];

export async function readEnv(path) {
  try { return parseEnv(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`Thiếu cấu hình ${path}; chạy pnpm env:init.`); throw error; }
}

export function validateInfra(env) {
  for (const service of services) {
    if (env[`${service.toUpperCase()}_DB_USER`] !== `${service}_app`) throw new Error(`Role ${service} phải là ${service}_app theo V001.`);
  }
  for (const key of ['POSTGRES_PASSWORD', 'RABBITMQ_DEFAULT_PASS', 'MINIO_ROOT_PASSWORD', ...services.map(s => `${s.toUpperCase()}_DB_PASSWORD`)]) {
    if (!env[key] || env[key].startsWith('change-me')) throw new Error(`Cần cấu hình secret hợp lệ cho ${key}.`);
  }
  for (const key of ['POSTGRES_PORT', 'RABBITMQ_PORT', 'RABBITMQ_MANAGEMENT_PORT', 'MINIO_API_PORT', 'MINIO_CONSOLE_PORT', 'MAILPIT_SMTP_PORT', 'MAILPIT_UI_PORT']) {
    if (!/^\d+$/.test(env[key] ?? '') || +env[key] < 1024 || +env[key] > 65535) throw new Error(`Cổng không hợp lệ: ${key}.`);
  }
  return env;
}

export function databaseUrl(env, service) {
  const url = new URL(`postgresql://127.0.0.1:${env.POSTGRES_PORT}/${service}_db`);
  url.username = `${service}_app`;
  url.password = env[`${service.toUpperCase()}_DB_PASSWORD`];
  return url.href;
}

export function appEnvironment(app, values, inherited = process.env) {
  // Retain OS/tooling variables, never another app's credentials or Node injection flags.
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^(DATABASE_|PG|POSTGRES_|IDENTITY_|TRIP_|TRAVEL_|FINANCE_|AUTOMATION_|RABBITMQ_|MINIO_|GATEWAY_|SMTP_|NODE_OPTIONS$|EXPORT_WORKER_PORT$)/i.test(key)));
  const identityKeys = ['IDENTITY_ACCESS_PRIVATE_KEY', 'IDENTITY_ACCESS_PUBLIC_KEY', 'IDENTITY_TOKEN_KEY', 'GATEWAY_IDENTITY_SECRET', 'AUTOMATION_IDENTITY_SECRET', 'TRIP_IDENTITY_SECRET', 'FINANCE_IDENTITY_SECRET', 'TRAVEL_IDENTITY_SECRET', 'EXPORT_IDENTITY_SECRET', 'IDENTITY_GRPC_PORT', 'RABBITMQ_URL', 'MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'IDENTITY_LINK_BASE_URL'];
  const gatewayKeys = ['IDENTITY_HTTP_URL', 'IDENTITY_GRPC_TARGET', 'GATEWAY_IDENTITY_SECRET', 'GATEWAY_CSRF_KEY', 'WEB_ORIGIN'];
  const automationKeys = ['IDENTITY_GRPC_TARGET', 'AUTOMATION_IDENTITY_SECRET', 'RABBITMQ_URL', 'SMTP_HOST', 'SMTP_PORT'];
  const allowed = ['NODE_ENV', app.portKey, ...(app.service ? ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DATABASE_CONNECT_TIMEOUT_MS', 'DATABASE_IDLE_TIMEOUT_MS', 'DATABASE_STATEMENT_TIMEOUT_MS'] : []), ...(app.name === 'identity-service' ? identityKeys : app.name === 'api-gateway' ? gatewayKeys : app.name === 'automation-service' ? automationKeys : [])];
  for (const key of allowed) if (values[key] !== undefined) clean[key] = values[key];
  return clean;
}

export async function initEnvironment(base = root) {
  let template = await readFile(resolve(base, '.env.example'), 'utf8');
  template = template.replace(/change-me-[\w-]+/g, () => randomBytes(24).toString('hex'));
  await createOnce(resolve(base, '.env'), template);
  const rootPath = resolve(base, '.env');
  const existingRoot = await readEnv(rootPath);
  if (Boolean(existingRoot.IDENTITY_ACCESS_PRIVATE_KEY) !== Boolean(existingRoot.IDENTITY_ACCESS_PUBLIC_KEY)) {
    throw new Error('Identity signing key pair is incomplete; restore the missing key instead of rotating only one half.');
  }
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const defaults = {
    MAILPIT_SMTP_PORT: '1025',
    MAILPIT_UI_PORT: '8025',
    GATEWAY_IDENTITY_SECRET: randomBytes(32).toString('hex'),
    AUTOMATION_IDENTITY_SECRET: randomBytes(32).toString('hex'),
    TRIP_IDENTITY_SECRET: randomBytes(32).toString('hex'),
    FINANCE_IDENTITY_SECRET: randomBytes(32).toString('hex'),
    TRAVEL_IDENTITY_SECRET: randomBytes(32).toString('hex'),
    EXPORT_IDENTITY_SECRET: randomBytes(32).toString('hex'),
    GATEWAY_CSRF_KEY: randomBytes(32).toString('hex'),
    IDENTITY_TOKEN_KEY: randomBytes(32).toString('hex'),
    IDENTITY_ACCESS_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    IDENTITY_ACCESS_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  const missing = Object.entries(defaults).filter(([key]) => !existingRoot[key]);
  if (missing.length) await appendFile(rootPath, `\n${missing.map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  const infra = validateInfra(await readEnv(rootPath));
  const shared = await readEnv(rootPath);
  for (const app of apps) {
    let content = await readFile(resolve(base, 'apps', app.name, '.env.example'), 'utf8');
    if (app.service) content = content.replace('DATABASE_URL=', `DATABASE_URL=${databaseUrl(infra, app.service)}`);
    const path = resolve(base, 'apps', app.name, '.env');
    await createOnce(path, content);
    const runtime = app.name === 'identity-service' ? {
      IDENTITY_GRPC_PORT: '3201',
      IDENTITY_ACCESS_PRIVATE_KEY: shared.IDENTITY_ACCESS_PRIVATE_KEY,
      IDENTITY_ACCESS_PUBLIC_KEY: shared.IDENTITY_ACCESS_PUBLIC_KEY,
      IDENTITY_TOKEN_KEY: shared.IDENTITY_TOKEN_KEY,
      GATEWAY_IDENTITY_SECRET: shared.GATEWAY_IDENTITY_SECRET,
      AUTOMATION_IDENTITY_SECRET: shared.AUTOMATION_IDENTITY_SECRET,
      TRIP_IDENTITY_SECRET: shared.TRIP_IDENTITY_SECRET,
      FINANCE_IDENTITY_SECRET: shared.FINANCE_IDENTITY_SECRET,
      TRAVEL_IDENTITY_SECRET: shared.TRAVEL_IDENTITY_SECRET,
      EXPORT_IDENTITY_SECRET: shared.EXPORT_IDENTITY_SECRET,
      RABBITMQ_URL: brokerUrl(shared),
      MINIO_ENDPOINT: `127.0.0.1:${shared.MINIO_API_PORT}`,
      MINIO_ACCESS_KEY: shared.MINIO_ROOT_USER,
      MINIO_SECRET_KEY: shared.MINIO_ROOT_PASSWORD,
      IDENTITY_LINK_BASE_URL: 'http://127.0.0.1:3000',
    } : app.name === 'api-gateway' ? {
      IDENTITY_HTTP_URL: `http://127.0.0.1:${appPort(base, 'identity-service', 3101)}`,
      IDENTITY_GRPC_TARGET: '127.0.0.1:3201',
      GATEWAY_IDENTITY_SECRET: shared.GATEWAY_IDENTITY_SECRET,
      GATEWAY_CSRF_KEY: shared.GATEWAY_CSRF_KEY,
      WEB_ORIGIN: 'http://127.0.0.1:3000',
    } : app.name === 'automation-service' ? {
      AUTOMATION_IDENTITY_SECRET: shared.AUTOMATION_IDENTITY_SECRET,
      IDENTITY_GRPC_TARGET: '127.0.0.1:3201',
      RABBITMQ_URL: brokerUrl(shared),
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: shared.MAILPIT_SMTP_PORT ?? '1025',
    } : {};
    const current = await readEnv(path);
    const additions = Object.entries(runtime).filter(([key]) => !current[key]);
    if (additions.length) await appendFile(path, `\n${additions.map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
    const existing = await readEnv(path);
    if (app.service && existing.DATABASE_URL !== databaseUrl(infra, app.service)) {
      throw new Error(`Cấu hình ${app.name} khác root .env; giữ nguyên file, cần đồng bộ credential/cổng thủ công.`);
    }
  }
}

function appPort(base, name, fallback) {
  try { return parseEnv(readFileSync(resolve(base, 'apps', name, '.env'), 'utf8')).IDENTITY_PORT ?? fallback; }
  catch { return fallback; }
}
function brokerUrl(env) {
  const url = new URL(`amqp://127.0.0.1:${env.RABBITMQ_PORT}`);
  url.username = env.RABBITMQ_DEFAULT_USER;
  url.password = env.RABBITMQ_DEFAULT_PASS;
  return url.href;
}

async function createOnce(path, content) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
