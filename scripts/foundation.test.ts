import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
// JavaScript CLI modules are exercised directly, without a second implementation.
// @ts-expect-error CLI is native ESM JavaScript.
import { root, apps, initEnvironment, appEnvironment } from './config.mjs';
// @ts-expect-error CLI is native ESM JavaScript.
import { migrationFiles } from './migrations.mjs';

describe('development configuration', () => {
  it('isolates the opt-in Finance inbox flag and strips inherited activation', () => {
    const key = 'AUTOMATION_FINANCE_NOTIFICATION_ENABLED';
    for (const app of apps) {
      expect(appEnvironment(app, { [key]: 'true' }, {})[key]).toBe(
        app.name === 'automation-service' ? 'true' : undefined,
      );
      expect(appEnvironment(app, {}, { [key]: 'true' })).not.toHaveProperty(key);
    }
  });
  it('forwards private storage configuration only to Identity and Finance', () => {
    const values = {
      MINIO_ENDPOINT: '127.0.0.1:9000',
      MINIO_ACCESS_KEY: 'test',
      MINIO_SECRET_KEY: 'test-secret',
    };
    for (const app of apps) {
      const result = appEnvironment(app, values, {});
      for (const key of Object.keys(values))
        expect(result[key]).toBe(
          ['identity-service', 'finance-service'].includes(app.name)
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
          ? ['V001', 'V002', 'V003', 'V004', 'V005']
          : ['trip', 'finance'].includes(service)
            ? ['V001', 'V002']
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
