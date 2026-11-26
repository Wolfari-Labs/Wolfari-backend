import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
// JavaScript CLI modules are exercised directly, without a second implementation.
// @ts-expect-error CLI is native ESM JavaScript.
import { root, apps, initEnvironment, initLocalEnvironment, appEnvironment, configureLocalFlightPriceWatch } from './config.mjs';
// @ts-expect-error CLI is native ESM JavaScript.
import { migrationFiles } from './migrations.mjs';

describe('development configuration', () => {
  it('enables live flight tracking on a fresh checkout using only the saved Automation key', async () => {
    const target = await mkdtemp(resolve(tmpdir(), 'wolfari-flight-setup-'));
    const automation = apps.find((app) => app.name === 'automation-service')!;
    const path = resolve(target, 'apps', automation.name, '.env');
    try {
      expect(await initLocalEnvironment({ target })).toBe(false);
      const original = await readFile(path, 'utf8');
      await expect(configureLocalFlightPriceWatch(target)).rejects.toThrow('SEARCHAPI_API_KEY');
      expect(await readFile(path, 'utf8')).toBe(original);

      const key = 'local-test-key';
      const saved = original.replace(/^SEARCHAPI_API_KEY=$/m, `SEARCHAPI_API_KEY=${key}`);
      await writeFile(path, saved);
      expect(await initLocalEnvironment({ target })).toBe(true);
      const configured = await readFile(path, 'utf8');
      const expected = {
        PRICE_WATCH_PROVIDER: 'SEARCHAPI_GOOGLE_FLIGHTS',
        PRICE_WATCH_WORKER_ENABLED: 'true',
      };
      expect(parseEnv(configured)).toEqual({ ...parseEnv(saved), ...expected });
      expect(appEnvironment(automation, parseEnv(configured), {})).toMatchObject({
        ...expected,
        SEARCHAPI_API_KEY: key,
      });
      await configureLocalFlightPriceWatch(target);
      expect(await initLocalEnvironment({ target, searchApiKey: 'another-key' })).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(configured);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
  it('imports the shell key on first local init and respects subsequent provider and worker choices', async () => {
    const target = await mkdtemp(resolve(tmpdir(), 'wolfari-flight-init-'));
    const path = resolve(target, 'apps', 'automation-service', '.env');
    const key = 'test-token_01+=';
    try {
      expect(await initLocalEnvironment({ target, searchApiKey: key })).toBe(true);
      const configured = await readFile(path, 'utf8');
      expect(parseEnv(configured)).toMatchObject({
        SEARCHAPI_API_KEY: key,
        PRICE_WATCH_PROVIDER: 'SEARCHAPI_GOOGLE_FLIGHTS',
        PRICE_WATCH_WORKER_ENABLED: 'true',
      });
      expect(await readFile(resolve(target, '.env'), 'utf8')).not.toContain(key);
      for (const app of apps.filter((app) => app.name !== 'automation-service')) {
        expect(await readFile(resolve(target, 'apps', app.name, '.env'), 'utf8')).not.toContain(key);
      }
      const paused = configured.replace('PRICE_WATCH_WORKER_ENABLED=true', 'PRICE_WATCH_WORKER_ENABLED=false');
      await writeFile(path, paused);
      expect(await initLocalEnvironment({ target })).toBe(false);
      expect(await readFile(path, 'utf8')).toBe(paused);

      const mock = paused.replace('PRICE_WATCH_PROVIDER=SEARCHAPI_GOOGLE_FLIGHTS', 'PRICE_WATCH_PROVIDER=MOCK_FLIGHT');
      await writeFile(path, mock);
      expect(await initLocalEnvironment({ target })).toBe(false);
      expect(await readFile(path, 'utf8')).toBe(mock);
      expect(await configureLocalFlightPriceWatch(target)).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(configured);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
  it('keeps shell input out of dotenv assignments when the token is malformed', async () => {
    const target = await mkdtemp(resolve(tmpdir(), 'wolfari-flight-key-'));
    try {
      await expect(initLocalEnvironment({ target, searchApiKey: 'test\nOTHER_FLAG=true' }))
        .rejects.toThrow('bearer token');
      const env = parseEnv(await readFile(resolve(target, 'apps/automation-service/.env'), 'utf8'));
      expect(env).toMatchObject({ SEARCHAPI_API_KEY: '', PRICE_WATCH_WORKER_ENABLED: 'false' });
      expect(env).not.toHaveProperty('OTHER_FLAG');
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
  it('isolates provider credentials and paired map secrets', () => {
    const owners: Record<string, string[]> = {
      GEOAPIFY_API_KEY: ['travel-intelligence-service'],
      TRAVELPAYOUTS_TOKEN: ['automation-service'],
      SEARCHAPI_API_KEY: ['automation-service'],
      PLACE_SELECTION_SECRET: ['trip-workspace-service', 'travel-intelligence-service'],
      GATEWAY_TRAVEL_SECRET: ['api-gateway', 'travel-intelligence-service'],
      BANK_WEBHOOK_SEPAY_SECRET: ['api-gateway'],
      BANK_WEBHOOK_SEPAY_API_KEY: ['api-gateway'],
      OSRM_PUBLIC_DEMO: ['travel-intelligence-service'],
      OSRM_WALKING_URL: ['travel-intelligence-service'],
    };
    for (const app of apps)
      for (const [key, names] of Object.entries(owners)) {
        expect(appEnvironment(app, { [key]: 'private-test' }, {})[key]).toBe(
          names.includes(app.name) ? 'private-test' : undefined,
        );
        expect(appEnvironment(app, {}, { [key]: 'inherited-private' })).not.toHaveProperty(key);
      }
  });
  it('isolates the opt-in Finance inbox flag and strips inherited activation', () => {
    const key = 'AUTOMATION_FINANCE_NOTIFICATION_ENABLED';
    for (const app of apps) {
      expect(appEnvironment(app, { [key]: 'true' }, {})[key]).toBe(
        app.name === 'automation-service' ? 'true' : undefined,
      );
      expect(appEnvironment(app, {}, { [key]: 'true' })).not.toHaveProperty(key);
    }
  });
  it('forwards private storage configuration only to Identity, Trip, Finance and Travel (POI photos)', () => {
    const values = {
      MINIO_ENDPOINT: '127.0.0.1:9000',
      MINIO_ACCESS_KEY: 'test',
      MINIO_SECRET_KEY: 'test-secret',
    };
    for (const app of apps) {
      const result = appEnvironment(app, values, {});
      for (const key of Object.keys(values))
        expect(result[key]).toBe(
          ['identity-service', 'trip-workspace-service', 'finance-service', 'travel-intelligence-service'].includes(app.name)
            ? values[key as keyof typeof values]
            : undefined,
        );
    }
  });
  it('isolates Gateway-Finance credentials and forwards only the required transport settings', () => {
    const values = {
      GATEWAY_FINANCE_SECRET: 'f'.repeat(64),
      FINANCE_GRPC_PORT: '3204',
      FINANCE_GRPC_TARGET: '127.0.0.1:3204',
    };
    for (const app of apps) {
      const result = appEnvironment(app, values, {});
      expect(result.GATEWAY_FINANCE_SECRET).toBe(
        ['api-gateway', 'finance-service'].includes(app.name)
          ? values.GATEWAY_FINANCE_SECRET
          : undefined,
      );
      expect(result.FINANCE_GRPC_PORT).toBe(app.name === 'finance-service' ? '3204' : undefined);
      expect(result.FINANCE_GRPC_TARGET).toBe(
        ['api-gateway', 'trip-workspace-service', 'automation-service'].includes(app.name)
          ? values.FINANCE_GRPC_TARGET
          : undefined,
      );
    }
  });
  it('isolates the Automation-Finance credential from every other app and inherited secrets', () => {
    const values = { AUTOMATION_FINANCE_SECRET: 'a'.repeat(64) };
    for (const app of apps) {
      const result = appEnvironment(app, values, { AUTOMATION_FINANCE_SECRET: 'foreign' });
      expect(result.AUTOMATION_FINANCE_SECRET).toBe(
        ['automation-service', 'finance-service'].includes(app.name)
          ? values.AUTOMATION_FINANCE_SECRET
          : undefined,
      );
      expect(appEnvironment(app, {}, { AUTOMATION_FINANCE_SECRET: 'foreign' })).not.toHaveProperty(
        'AUTOMATION_FINANCE_SECRET',
      );
    }
  });
  it('forwards the opt-in outbox flag only to Finance and strips inherited activation', () => {
    for (const app of apps) {
      const values = appEnvironment(
        app,
        { FINANCE_OUTBOX_ENABLED: 'true' },
        { FINANCE_OUTBOX_ENABLED: 'true' },
      );
      expect(values.FINANCE_OUTBOX_ENABLED).toBe(
        app.name === 'finance-service' ? 'true' : undefined,
      );
      expect(appEnvironment(app, {}, { FINANCE_OUTBOX_ENABLED: 'true' })).not.toHaveProperty(
        'FINANCE_OUTBOX_ENABLED',
      );
    }
    const finance = apps.find((app) => app.name === 'finance-service')!;
    expect(
      appEnvironment(finance, { RABBITMQ_URL: 'amqp://synthetic-fixture' }, {}).RABBITMQ_URL,
    ).toBe('amqp://synthetic-fixture');
    expect(
      appEnvironment(apps[0], { RABBITMQ_URL: 'amqp://synthetic-fixture' }, {}),
    ).not.toHaveProperty('RABBITMQ_URL');
  });
  it('generates unique secrets, preserves files, and detects conflicting app credentials', async () => {
    const base = await mkdtemp(resolve(tmpdir(), 'wolfari-env-test-'));
    try {
      await writeFile(resolve(base, '.env.example'), await readFile(resolve(root, '.env.example')));
      for (const app of apps) {
        await mkdir(resolve(base, 'apps', app.name), { recursive: true });
        await writeFile(
          resolve(base, 'apps', app.name, '.env.example'),
          await readFile(resolve(root, 'apps', app.name, '.env.example')),
        );
      }
      await initEnvironment(base);
      const first = await readFile(resolve(base, '.env'), 'utf8');
      expect(first).not.toContain('change-me-');
      const shared = parseEnv(first);
      expect(shared.AUTOMATION_FINANCE_SECRET).toMatch(/^[a-f0-9]{64}$/);
      expect(shared.AUTOMATION_FINANCE_SECRET).not.toBe(shared.GATEWAY_FINANCE_SECRET);
      expect(shared.AUTOMATION_FINANCE_SECRET).not.toBe(shared.TRIP_FINANCE_SECRET);
      for (const app of apps) {
        const appEnv = parseEnv(await readFile(resolve(base, 'apps', app.name, '.env'), 'utf8'));
        if (app.name === 'finance-service') {
          expect(appEnv.FINANCE_OUTBOX_ENABLED).toBe('false');
          expect(appEnv.RABBITMQ_URL).toMatch(/^amqp:\/\//);
        }
        expect(appEnv.AUTOMATION_FINANCE_SECRET).toBe(
          ['automation-service', 'finance-service'].includes(app.name)
            ? shared.AUTOMATION_FINANCE_SECRET
            : undefined,
        );
      }
      const secrets = [...first.matchAll(/(?:PASSWORD|PASS)=(\w+)/g)].map((match) => match[1]);
      expect(new Set(secrets).size).toBe(secrets.length);
      await initEnvironment(base);
      expect(await readFile(resolve(base, '.env'), 'utf8')).toBe(first);
      const appPath = resolve(base, 'apps/identity-service/.env');
      await writeFile(appPath, 'DATABASE_URL=postgresql://wrong@localhost/identity_db');
      await expect(initEnvironment(base)).rejects.toThrow('khác root');
      expect(await readFile(appPath, 'utf8')).toContain('wrong');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  it('strips foreign and inherited credentials from app processes', () => {
    const inherited = {
      PATH: 'tools',
      IDENTITY_DB_PASSWORD: 'secret',
      FINANCE_DATABASE_URL: 'secret',
      PGHOST: 'secret',
      DATABASE_URL: 'secret',
      MINIO_ROOT_PASSWORD: 'secret',
      NODE_OPTIONS: '--require evil',
    };
    expect(
      appEnvironment(apps[0], { DATABASE_URL: 'ignored', GATEWAY_PORT: '3000' }, inherited),
    ).toEqual({ PATH: 'tools', GATEWAY_PORT: '3000' });
    expect(appEnvironment(apps[1], { DATABASE_URL: 'own' }, inherited)).toEqual({
      PATH: 'tools',
      DATABASE_URL: 'own',
    });
  });
  it('distributes each Trip caller secret only to its server and owning caller', () => {
    const values = {
      TRIP_GRPC_PORT: '3202',
      TRIP_GRPC_TARGET: '127.0.0.1:3202',
      GATEWAY_TRIP_SECRET: 'g'.repeat(64),
      FINANCE_TRIP_SECRET: 'f'.repeat(64),
      TRAVEL_TRIP_SECRET: 't'.repeat(64),
      AUTOMATION_TRIP_SECRET: 'a'.repeat(64),
    };
    const environment = (name: string) =>
      appEnvironment(
        apps.find((app) => app.name === name)!,
        values,
        {},
      );
    expect(environment('trip-workspace-service')).toMatchObject({
      TRIP_GRPC_PORT: values.TRIP_GRPC_PORT,
      GATEWAY_TRIP_SECRET: values.GATEWAY_TRIP_SECRET,
      FINANCE_TRIP_SECRET: values.FINANCE_TRIP_SECRET,
      TRAVEL_TRIP_SECRET: values.TRAVEL_TRIP_SECRET,
      AUTOMATION_TRIP_SECRET: values.AUTOMATION_TRIP_SECRET,
    });
    for (const [name, owned] of [
      ['api-gateway', 'GATEWAY_TRIP_SECRET'],
      ['finance-service', 'FINANCE_TRIP_SECRET'],
      ['travel-intelligence-service', 'TRAVEL_TRIP_SECRET'],
      ['automation-service', 'AUTOMATION_TRIP_SECRET'],
    ] as const) {
      const caller = environment(name);
      expect(caller).toMatchObject({
        TRIP_GRPC_TARGET: values.TRIP_GRPC_TARGET,
        [owned]: values[owned],
      });
      for (const secret of [
        'GATEWAY_TRIP_SECRET',
        'FINANCE_TRIP_SECRET',
        'TRAVEL_TRIP_SECRET',
        'AUTOMATION_TRIP_SECRET',
      ] as const) {
        if (secret !== owned) expect(caller).not.toHaveProperty(secret);
      }
    }
  });
  it('distributes the Gateway-Automation secret only to both endpoints', () => {
    const values = {
      AUTOMATION_GRPC_PORT: '3205',
      AUTOMATION_GRPC_TARGET: '127.0.0.1:3205',
      GATEWAY_AUTOMATION_SECRET: 'g'.repeat(64),
      AUTOMATION_CURSOR_SECRET: 'c'.repeat(64),
    };
    const environment = (name: string) =>
      appEnvironment(
        apps.find((app) => app.name === name)!,
        values,
        {},
      );
    expect(environment('api-gateway')).toMatchObject({
      AUTOMATION_GRPC_TARGET: values.AUTOMATION_GRPC_TARGET,
      GATEWAY_AUTOMATION_SECRET: values.GATEWAY_AUTOMATION_SECRET,
    });
    expect(environment('automation-service')).toMatchObject({
      AUTOMATION_GRPC_PORT: values.AUTOMATION_GRPC_PORT,
      GATEWAY_AUTOMATION_SECRET: values.GATEWAY_AUTOMATION_SECRET,
      AUTOMATION_CURSOR_SECRET: values.AUTOMATION_CURSOR_SECRET,
    });
    expect(environment('trip-workspace-service')).not.toHaveProperty('GATEWAY_AUTOMATION_SECRET');
  });
  it('verifies every baseline SQL checksum against the committed manifest', async () => {
    for (const service of ['identity', 'trip', 'travel', 'finance', 'automation']) {
      expect(
        (await migrationFiles(service)).map((file: { version: string }) => file.version),
      ).toEqual(
        service === 'automation'
          ? ['V001', 'V002', 'V003', 'V004', 'V005', 'V006', 'V007', 'V008', 'V009', 'V010']
          : service === 'trip'
            ? ['V001', 'V002', 'V003', 'V004', 'V005', 'V006']
            : service === 'finance'
              ? ['V001', 'V002', 'V003', 'V004', 'V005', 'V006', 'V007', 'V008']
              : service === 'identity'
                ? ['V001', 'V002']
                : service === 'travel'
                  ? ['V001', 'V002', 'V003', 'V004', 'V005', 'V006']
                  : ['V001'],
      );
    }
  });
  it('refuses modified SQL before connecting to PostgreSQL', async () => {
    const base = await mkdtemp(resolve(tmpdir(), 'wolfari-checksum-test-'));
    try {
      await mkdir(resolve(base, 'docs/database'), { recursive: true });
      await mkdir(resolve(base, 'apps/identity-service/migrations'), { recursive: true });
      await writeFile(
        resolve(base, 'docs/database/SHA256SUMS.txt'),
        await readFile(resolve(root, 'docs/database/SHA256SUMS.txt')),
      );
      await writeFile(
        resolve(base, 'apps/identity-service/migrations/V001.sql'),
        'BEGIN; SELECT 1; COMMIT;',
      );
      await expect(migrationFiles('identity', base)).rejects.toThrow('CHECKSUM_MISMATCH');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  it('rejects forward manifest overrides, duplicates and modified V002 bytes', async () => {
    const base = await mkdtemp(resolve(tmpdir(), 'wolfari-forward-test-'));
    try {
      await mkdir(resolve(base, 'docs/database'), { recursive: true });
      await mkdir(resolve(base, 'apps/trip-workspace-service/migrations'), { recursive: true });
      const baseline = await readFile(resolve(root, 'docs/database/SHA256SUMS.txt'), 'utf8');
      const forward = await readFile(resolve(root, 'docs/database/SHA256SUMS.forward.txt'), 'utf8');
      await writeFile(resolve(base, 'docs/database/SHA256SUMS.txt'), baseline);
      await writeFile(resolve(base, 'docs/database/SHA256SUMS.forward.txt'), forward + forward);
      await expect(migrationFiles('trip', base)).rejects.toThrow('DUPLICATE_MANIFEST_PATH');
      await writeFile(
        resolve(base, 'docs/database/SHA256SUMS.forward.txt'),
        baseline.split(/\r?\n/).find((line) => line.includes('/V001.sql'))!,
      );
      await expect(migrationFiles('trip', base)).rejects.toThrow('INVALID_FORWARD_MANIFEST');
      await writeFile(resolve(base, 'docs/database/SHA256SUMS.forward.txt'), forward);
      await writeFile(
        resolve(base, 'apps/trip-workspace-service/migrations/V001.sql'),
        await readFile(resolve(root, 'apps/trip-workspace-service/migrations/V001.sql')),
      );
      await writeFile(resolve(base, 'apps/trip-workspace-service/migrations/V002.sql'), 'tampered');
      await expect(migrationFiles('trip', base)).rejects.toThrow('CHECKSUM_MISMATCH');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
