import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { apps, root, initEnvironment, readEnv, databaseUrl } from './config.mjs';

export const demoRoot = resolve(root, '.local/demo');
export const project = 'wolfari-demo';
export const volumeNames = ['postgres_data', 'rabbitmq_data', 'minio_data'];
export const infraPorts = {
  POSTGRES_PORT: '15432',
  RABBITMQ_PORT: '25672',
  RABBITMQ_MANAGEMENT_PORT: '25673',
  MINIO_API_PORT: '19000',
  MINIO_CONSOLE_PORT: '19001',
  MAILPIT_SMTP_PORT: '11025',
  MAILPIT_UI_PORT: '18025',
};
export const publicConfig = {
  version: 1,
  project,
  webUrl: 'http://localhost:5273',
  gatewayUrl: 'http://127.0.0.1:13000',
  mailpitUrl: 'http://127.0.0.1:18025',
  backendRoot: root,
};
function composeOverlay(manifest) {
  return {
    services: Object.fromEntries(
      ['postgres', 'rabbitmq', 'minio', 'mailpit'].map((name) => [
        name,
        { labels: { 'io.wolfari.demo.instance': manifest.instanceId } },
      ]),
    ),
    volumes: Object.fromEntries(
      volumeNames.map((name) => [
        name,
        { labels: { 'io.wolfari.demo.instance': manifest.instanceId } },
      ]),
    ),
  };
}
export function appOverrides() {
  const result = {};
  const targets = {
    IDENTITY_GRPC_TARGET: '127.0.0.1:13201',
    TRIP_GRPC_TARGET: '127.0.0.1:13202',
    FINANCE_GRPC_TARGET: '127.0.0.1:13204',
    AUTOMATION_GRPC_TARGET: '127.0.0.1:13205',
  };
  for (const app of apps)
    result[app.name] = {
      NODE_ENV: 'development',
      WOLFARI_ISOLATED_ENV: '1',
      [app.portKey]: String(app.port + 10000),
      ...targets,
    };
  Object.assign(result['api-gateway'], {
    IDENTITY_HTTP_URL: 'http://127.0.0.1:13101',
    TRIP_HTTP_URL: 'http://127.0.0.1:13102',
    FINANCE_HTTP_URL: 'http://127.0.0.1:13104',
    AUTOMATION_HTTP_URL: 'http://127.0.0.1:13105',
    WEB_ORIGIN: publicConfig.webUrl,
    GATEWAY_LOCAL_RATE_LIMIT_MULTIPLIER: '20',
  });
  Object.assign(result['identity-service'], {
    IDENTITY_GRPC_PORT: '13201',
    IDENTITY_LINK_BASE_URL: publicConfig.webUrl,
    IDENTITY_VERIFY_LINK_PATH: '/verify-email',
    IDENTITY_RESET_LINK_PATH: '/reset-password',
  });
  Object.assign(result['trip-workspace-service'], {
    TRIP_GRPC_PORT: '13202',
    TRIP_INVITATION_LINK_BASE_URL: publicConfig.webUrl,
    TRIP_OUTBOX_ENABLED: 'true',
    TRIP_MEMBERSHIP_LIFECYCLE_ENABLED: 'true',
  });
  Object.assign(result['finance-service'], {
    FINANCE_GRPC_PORT: '13204',
    MOMO_SANDBOX_MODE: 'disabled',
  });
  Object.assign(result['automation-service'], {
    AUTOMATION_GRPC_PORT: '13205',
    PRICE_WATCH_WORKER_ENABLED: 'true',
  });
  return result;
}
async function createOnce(path, value) {
  try {
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
export async function initDemo() {
  await mkdir(demoRoot, { recursive: true });
  await createOnce(resolve(demoRoot, 'manifest.json'), {
    ...publicConfig,
    instanceId: randomUUID(),
    controlToken: randomBytes(32).toString('hex'),
  });
  const manifest = await loadManifest();
  await initEnvironment(root, {
    target: demoRoot,
    rootOverrides: infraPorts,
    appOverrides: appOverrides(),
  });
  await createOnce(resolve(demoRoot, 'public.json'), {
    ...publicConfig,
    instanceId: manifest.instanceId,
  });
  await createOnce(resolve(demoRoot, 'compose.demo.json'), composeOverlay(manifest));
  await loadDemo();
  console.log('Demo initialized; development configuration unchanged. Secrets retained on rerun.');
}
export async function loadManifest() {
  const value = JSON.parse(await readFile(resolve(demoRoot, 'manifest.json'), 'utf8'));
  if (
    value.project !== project ||
    value.backendRoot !== root ||
    value.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.instanceId) ||
    !/^[a-f0-9]{64}$/.test(value.controlToken)
  )
    throw new Error('DEMO_MANIFEST_INVALID');
  for (const key of ['webUrl', 'gatewayUrl', 'mailpitUrl'])
    if (value[key] !== publicConfig[key]) throw new Error('DEMO_URL_MISMATCH');
  return value;
}
export async function loadDemo() {
  const manifest = await loadManifest();
  const env = await readEnv(resolve(demoRoot, '.env'));
  const overlay = JSON.parse(await readFile(resolve(demoRoot, 'compose.demo.json'), 'utf8'));
  if (JSON.stringify(overlay) !== JSON.stringify(composeOverlay(manifest)))
    throw new Error('DEMO_COMPOSE_OVERRIDE_MISMATCH');
  const published = JSON.parse(await readFile(resolve(demoRoot, 'public.json'), 'utf8'));
  if (
    JSON.stringify(published) !==
    JSON.stringify({ ...publicConfig, instanceId: manifest.instanceId })
  )
    throw new Error('DEMO_PUBLIC_CONFIG_MISMATCH');
  for (const [key, value] of Object.entries(infraPorts))
    if (env[key] !== value) throw new Error(`DEMO_PORT_MISMATCH: ${key}`);
  const configs = {};
  for (const app of apps) {
    const values = await readEnv(resolve(demoRoot, 'apps', app.name, '.env'));
    for (const [key, value] of Object.entries(appOverrides()[app.name]))
      if (values[key] !== value) throw new Error(`DEMO_CONFIG_MISMATCH: ${app.name}/${key}`);
    if (app.service && values.DATABASE_URL !== databaseUrl(env, app.service))
      throw new Error(`DEMO_DATABASE_MISMATCH: ${app.name}`);
    if (values.RABBITMQ_URL) {
      const broker = new URL(values.RABBITMQ_URL);
      if (
        broker.hostname !== '127.0.0.1' ||
        broker.port !== env.RABBITMQ_PORT ||
        decodeURIComponent(broker.username) !== env.RABBITMQ_DEFAULT_USER ||
        decodeURIComponent(broker.password) !== env.RABBITMQ_DEFAULT_PASS
      )
        throw new Error('DEMO_BROKER_MISMATCH');
    }
    if (
      values.MINIO_ENDPOINT &&
      (values.MINIO_ENDPOINT !== `127.0.0.1:${env.MINIO_API_PORT}` ||
        values.MINIO_ACCESS_KEY !== env.MINIO_ROOT_USER ||
        values.MINIO_SECRET_KEY !== env.MINIO_ROOT_PASSWORD)
    )
      throw new Error('DEMO_STORAGE_MISMATCH');
    if (
      app.name === 'automation-service' &&
      (values.SMTP_HOST !== '127.0.0.1' || values.SMTP_PORT !== env.MAILPIT_SMTP_PORT)
    )
      throw new Error('DEMO_SMTP_MISMATCH');
    for (const [key, value] of Object.entries(values))
      if (
        env[key] !== undefined &&
        /(?:_SECRET|_TOKEN_KEY|_PRIVATE_KEY|_PUBLIC_KEY|_CSRF_KEY)$/.test(key) &&
        value !== env[key]
      )
        throw new Error(`DEMO_CREDENTIAL_MISMATCH: ${app.name}/${key}`);
    configs[app.name] = values;
  }
  return {
    manifest,
    env,
    configs,
    composeOptions: {
      project,
      envFile: resolve(demoRoot, '.env'),
      overrides: [resolve(demoRoot, 'compose.demo.json')],
    },
  };
}
export function assertOwnedResource(value, manifest, kind) {
  const labels = value.Labels ?? value.Config?.Labels ?? {};
  if (
    labels['com.docker.compose.project'] !== project ||
    labels['io.wolfari.demo.instance'] !== manifest.instanceId
  )
    throw new Error('DEMO_RESOURCE_NOT_OWNED');
  if (kind === 'volume' && !volumeNames.map((name) => `${project}_${name}`).includes(value.Name))
    throw new Error('DEMO_VOLUME_NOT_ALLOWED');
  if (
    kind === 'container' &&
    !['postgres', 'rabbitmq', 'minio', 'mailpit'].includes(labels['com.docker.compose.service'])
  )
    throw new Error('DEMO_CONTAINER_NOT_ALLOWED');
}
