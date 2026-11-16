import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { apps, root, initEnvironment, readEnv, appEnvironment, services } from './config.mjs';
import { migrate, migrationFiles } from './migrations.mjs';

const require = createRequire(import.meta.url);
const { validateAppEnvironment } = require('../packages/common/dist/index.js');
export const trialProject = 'wolfari-trial';
export const origin = 'https://wolfari.thepiece.io.vn';
export function configDirectory(value = process.env.WOLFARI_CONFIG_DIR ?? '/etc/wolfari') {
  if (
    !isAbsolute(value) ||
    resolve(value) === parse(resolve(value)).root ||
    resolve(value) === root ||
    resolve(value).startsWith(root + sep)
  )
    throw new Error('TRIAL_CONFIG_MUST_BE_SEPARATE_ABSOLUTE_PATH');
  return resolve(value);
}
async function writeEnv(path, values) {
  for (const value of Object.values(values))
    if (/[\r\n]/.test(String(value))) throw new Error('MULTILINE_ENV_NOT_ALLOWED');
  await writeFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
}
export async function initTrial(directory) {
  try {
    await access(directory);
    throw new Error('TRIAL_INIT_REQUIRES_NEW_DIRECTORY');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await initEnvironment(root, { target: directory });
  const shared = await readEnv(resolve(directory, '.env'));
  // Root infra env has no JWT/service credentials; apps receive only their own keys.
  const infra = Object.fromEntries(
    Object.entries(shared).filter(([key]) =>
      /^(POSTGRES_|IDENTITY_DB_|TRIP_DB_|TRAVEL_DB_|FINANCE_DB_|AUTOMATION_DB_|RABBITMQ_DEFAULT_|RABBITMQ_PORT$|RABBITMQ_MANAGEMENT_PORT$|MINIO_ROOT_|MINIO_API_PORT$|MINIO_CONSOLE_PORT$)/.test(
        key,
      ),
    ),
  );
  await writeEnv(resolve(directory, '.env'), infra);
  for (const app of apps) {
    const path = resolve(directory, 'apps', app.name, '.env');
    const values = await readEnv(path);
    Object.assign(values, {
      NODE_ENV: 'production',
      WOLFARI_DEPLOYMENT_PROFILE: 'single-host-trial',
      WOLFARI_ISOLATED_ENV: '1',
    });
    if (app.name === 'api-gateway')
      Object.assign(values, { WEB_ORIGIN: origin, GATEWAY_LOCAL_RATE_LIMIT_MULTIPLIER: '1' });
    if (app.name === 'identity-service')
      Object.assign(values, {
        IDENTITY_LINK_BASE_URL: origin,
        IDENTITY_VERIFY_LINK_PATH: '/verify-email',
        IDENTITY_RESET_LINK_PATH: '/reset-password',
        IDENTITY_REGISTRATION_ALLOWLIST: '',
      });
    if (app.name === 'trip-workspace-service')
      Object.assign(values, {
        TRIP_INVITATION_LINK_BASE_URL: origin,
        TRIP_OUTBOX_ENABLED: 'true',
        TRIP_MEMBERSHIP_LIFECYCLE_ENABLED: 'false',
      });
    if (app.name === 'finance-service')
      Object.assign(values, { MOMO_SANDBOX_MODE: 'disabled', FINANCE_OUTBOX_ENABLED: 'false' });
    if (app.name === 'automation-service')
      Object.assign(values, {
        SMTP_HOST: 'smtp-relay.brevo.com',
        SMTP_PORT: '587',
        SMTP_USER: '',
        SMTP_PASSWORD: '',
        SMTP_REQUIRE_TLS: 'true',
        SMTP_FROM: 'Wolfari <no-reply@wolfari.thepiece.io.vn>',
        PRICE_WATCH_WORKER_ENABLED: 'false',
        PRICE_WATCH_PROVIDER: 'TRAVELPAYOUTS_CACHE',
        TRAVELPAYOUTS_VND_VERIFIED: 'false',
        AUTOMATION_FINANCE_NOTIFICATION_ENABLED: 'false',
      });
    if (['identity-service', 'finance-service'].includes(app.name)) {
      values.MINIO_ACCESS_KEY =
        app.name === 'identity-service' ? 'wolfari_identity' : 'wolfari_finance';
      values.MINIO_SECRET_KEY = randomBytes(32).toString('hex');
    }
    await writeEnv(path, values);
  }
  await writeFile(
    resolve(directory, 'trial-instance.json'),
    JSON.stringify(
      {
        profile: 'single-host-trial',
        project: trialProject,
        origin,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    'Trial config generated. Fill SMTP/allowlist and provision MinIO app users. No secrets printed.',
  );
}
async function checkMarker(directory) {
  const marker = JSON.parse(await readFile(resolve(directory, 'trial-instance.json'), 'utf8'));
  if (
    marker.profile !== 'single-host-trial' ||
    marker.project !== trialProject ||
    marker.origin !== origin
  )
    throw new Error('WRONG_TRIAL_CONFIG');
}
// App startup must not read root infrastructure passwords. Pair validation is an
// operator preflight; services read only app configuration and the instance marker.
export async function readTrialApp(directory, app) {
  await checkMarker(directory);
  const values = await readEnv(resolve(directory, 'apps', app.name, '.env'));
  validateAppEnvironment(values, app.name);
  for (const key of ['WEB_ORIGIN', 'IDENTITY_LINK_BASE_URL', 'TRIP_INVITATION_LINK_BASE_URL']) {
    if (values[key] && values[key] !== origin) throw new Error(`WRONG_PUBLIC_ORIGIN:${key}`);
  }
  return values;
}
export async function checkTrial(directory) {
  await checkMarker(directory);
  const configs = new Map();
  const paired = new Map();
  const infra = await readEnv(resolve(directory, '.env'));
  for (const key of [
    'POSTGRES_PASSWORD',
    'RABBITMQ_DEFAULT_PASS',
    'MINIO_ROOT_PASSWORD',
    ...services.map((service) => `${service.toUpperCase()}_DB_PASSWORD`),
  ]) {
    if (!infra[key] || infra[key].length < 32 || /change-me|replace-me/i.test(infra[key]))
      throw new Error(`INVALID_INFRA_SECRET:${key}`);
  }
  const ports = [
    'POSTGRES_PORT',
    'RABBITMQ_PORT',
    'RABBITMQ_MANAGEMENT_PORT',
    'MINIO_API_PORT',
    'MINIO_CONSOLE_PORT',
  ].map((key) => infra[key]);
  if (ports.some((port) => !/^\d+$/.test(port ?? '') || +port < 1024 || +port > 65535))
    throw new Error('INVALID_INFRA_PORT');
  for (const app of apps) {
    const values = await readEnv(resolve(directory, 'apps', app.name, '.env'));
    validateAppEnvironment(values, app.name);
    ports.push(values[app.portKey]);
    const grpcKey = Object.keys(values).find((key) => key.endsWith('_GRPC_PORT'));
    if (grpcKey) ports.push(values[grpcKey]);
    for (const [key, value] of Object.entries(values)) {
      if (key.endsWith('_SECRET') && key !== 'MOMO_SECRET_KEY') {
        if (paired.has(key) && paired.get(key) !== value)
          throw new Error(`SECRET_PAIR_MISMATCH:${key}`);
        paired.set(key, value);
      }
      if (
        ['WEB_ORIGIN', 'IDENTITY_LINK_BASE_URL', 'TRIP_INVITATION_LINK_BASE_URL'].includes(key) &&
        value !== origin
      )
        throw new Error(`WRONG_PUBLIC_ORIGIN:${key}`);
    }
    if (app.service) {
      const url = new URL(values.DATABASE_URL);
      if (
        url.pathname !== `/${app.service}_db` ||
        decodeURIComponent(url.username) !== `${app.service}_app` ||
        infra[`${app.service.toUpperCase()}_DB_USER`] !== `${app.service}_app` ||
        decodeURIComponent(url.password) !== infra[`${app.service.toUpperCase()}_DB_PASSWORD`] ||
        url.port !== infra.POSTGRES_PORT
      )
        throw new Error(`DB_PAIR_MISMATCH:${app.service}`);
      await migrationFiles(app.service);
    }
    if (values.RABBITMQ_URL) {
      const broker = new URL(values.RABBITMQ_URL);
      if (
        broker.port !== infra.RABBITMQ_PORT ||
        decodeURIComponent(broker.username) !== infra.RABBITMQ_DEFAULT_USER ||
        decodeURIComponent(broker.password) !== infra.RABBITMQ_DEFAULT_PASS
      )
        throw new Error('BROKER_PAIR_MISMATCH');
    }
    if (values.MINIO_ENDPOINT && values.MINIO_ENDPOINT !== `127.0.0.1:${infra.MINIO_API_PORT}`)
      throw new Error('STORAGE_PORT_MISMATCH');
    if (
      values.MINIO_ACCESS_KEY &&
      (values.MINIO_ACCESS_KEY === infra.MINIO_ROOT_USER ||
        values.MINIO_SECRET_KEY === infra.MINIO_ROOT_PASSWORD)
    )
      throw new Error('MINIO_ROOT_CREDENTIALS_FORBIDDEN');
    configs.set(app.name, values);
  }
  const gateway = configs.get('api-gateway'), travel = configs.get('travel-intelligence-service'), trip = configs.get('trip-workspace-service');
  if (gateway.GATEWAY_TRAVEL_SECRET || travel.GATEWAY_TRAVEL_SECRET || travel.PLACE_SELECTION_SECRET || trip.PLACE_SELECTION_SECRET) {
    if (!gateway.GATEWAY_TRAVEL_SECRET || gateway.GATEWAY_TRAVEL_SECRET!==travel.GATEWAY_TRAVEL_SECRET || !travel.PLACE_SELECTION_SECRET || travel.PLACE_SELECTION_SECRET!==trip.PLACE_SELECTION_SECRET || !travel.TRAVEL_GRPC_PORT || !gateway.TRAVEL_GRPC_TARGET)
      throw new Error('PLACES_CONFIG_PAIR_INCOMPLETE');
  }
  if (new Set(paired.values()).size !== paired.size)
    throw new Error('SERVICE_SECRETS_MUST_BE_INDEPENDENT');
  if (new Set(ports).size !== ports.length) throw new Error('TRIAL_PORT_COLLISION');
  if (configs.get('api-gateway').GATEWAY_PORT !== '3000')
    throw new Error('CADDY_GATEWAY_PORT_MISMATCH');
  for (const values of configs.values()) {
    for (const [prefix, appName] of Object.entries({
      IDENTITY: 'identity-service',
      TRIP: 'trip-workspace-service',
      TRAVEL: 'travel-intelligence-service',
      FINANCE: 'finance-service',
      AUTOMATION: 'automation-service',
    })) {
      const target = configs.get(appName);
      if (
        values[`${prefix}_GRPC_TARGET`] &&
        values[`${prefix}_GRPC_TARGET`] !== `127.0.0.1:${target[`${prefix}_GRPC_PORT`]}`
      )
        throw new Error(`GRPC_PORT_MISMATCH:${prefix}`);
      if (
        values[`${prefix}_HTTP_URL`] &&
        values[`${prefix}_HTTP_URL`] !== `http://127.0.0.1:${target[`${prefix}_PORT`]}`
      )
        throw new Error(`HTTP_PORT_MISMATCH:${prefix}`);
    }
  }
  return configs;
}
export function composeArgs(directory, rest) {
  return [
    'compose',
    '--project-name',
    trialProject,
    '--env-file',
    resolve(directory, '.env'),
    '-f',
    resolve(root, 'infrastructure/docker-compose.yml'),
    '-f',
    resolve(root, 'deployment/compose.trial.yml'),
    ...rest,
  ];
}
function run(command, args, env = process.env) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? done() : reject(new Error(`TRIAL_COMMAND_FAILED:${code}`)),
    );
  });
}
export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const directory = configDirectory();
  if (command === 'init') return initTrial(directory);
  if (command === 'compose') {
    const allowed = ['up', 'ps', 'logs', 'stop', 'start', 'config', 'build'];
    if (
      !allowed.includes(rest[0]) ||
      (rest[0] === 'config' && (rest.length !== 2 || rest[1] !== '--quiet')) ||
      rest.some((value) => ['--volumes', '-v', '--remove-orphans'].includes(value))
    )
      throw new Error('UNSAFE_COMPOSE_COMMAND');
    // Build/start infrastructure before credentials can be tested, but require ownership marker.
    const marker = JSON.parse(await readFile(resolve(directory, 'trial-instance.json'), 'utf8'));
    if (marker.project !== trialProject) throw new Error('WRONG_TRIAL_CONFIG');
    return run('docker', composeArgs(directory, rest));
  }
  if (command === 'start') {
    const app = apps.find((item) => item.name === rest[0]);
    if (!app) throw new Error('UNKNOWN_APP');
    const values = await readTrialApp(directory, app);
    const child = spawn(process.execPath, [resolve(root, 'apps', app.name, 'dist/main.js')], {
      cwd: root,
      env: appEnvironment(app, values),
      stdio: 'inherit',
    });
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => child.kill('SIGINT'));
    child.on('error', () => {
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  const configs =
    command === 'health'
      ? new Map(
          await Promise.all(
            apps.map(async (app) => [app.name, await readTrialApp(directory, app)]),
          ),
        )
      : await checkTrial(directory);
  if (command === 'check') {
    console.log('PASS trial config, paired secrets and migration checksums (not runtime health)');
    return;
  }
  if (command === 'migrate') {
    for (const service of services) {
      const app = apps.find((item) => item.service === service);
      await migrate(service, configs.get(app.name).DATABASE_URL, await migrationFiles(service));
      console.log(`PASS migration ${service}`);
    }
    return;
  }
  if (command === 'health') {
    for (const app of apps) {
      const env = configs.get(app.name);
      for (const endpoint of app.name === 'export-worker'
        ? ['live']
        : app.name === 'api-gateway'
          ? ['ready', 'dependencies']
          : ['ready']) {
        const response = await fetch(`http://127.0.0.1:${env[app.portKey]}/health/${endpoint}`, {
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HEALTH_FAILED:${app.name}:${endpoint}`);
      }
    }
    console.log(
      'PASS app health; still verify SMTP delivery, storage permissions and public HTTPS',
    );
    return;
  }
  throw new Error('UNKNOWN_TRIAL_COMMAND');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      /^(Invalid trial configuration:|[A-Z_]+(?::[\w-]+)*)$/.test(error.message)
        ? error.message
        : 'Trial operation failed; inspect configuration locally without printing secrets.',
    );
    process.exitCode = 1;
  });
}
