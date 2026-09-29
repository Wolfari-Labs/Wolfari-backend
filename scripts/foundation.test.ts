import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
// JavaScript CLI modules are exercised directly, without a second implementation.
// @ts-expect-error CLI is native ESM JavaScript.
import { root, apps, initEnvironment, appEnvironment } from './config.mjs';
// @ts-expect-error CLI is native ESM JavaScript.
import { migrationFiles } from './migrations.mjs';

describe('development configuration', () => {
  it('generates unique secrets, preserves files, and detects conflicting app credentials', async () => {
    const base = await mkdtemp(resolve(tmpdir(), 'wolfari-env-test-'));
    try {
      await writeFile(resolve(base, '.env.example'), await readFile(resolve(root, '.env.example')));
      for (const app of apps) {
        await mkdir(resolve(base, 'apps', app.name), { recursive: true });
        await writeFile(resolve(base, 'apps', app.name, '.env.example'), await readFile(resolve(root, 'apps', app.name, '.env.example')));
      }
      await initEnvironment(base);
      const first = await readFile(resolve(base, '.env'), 'utf8');
      expect(first).not.toContain('change-me-');
      const secrets = [...first.matchAll(/(?:PASSWORD|PASS)=(\w+)/g)].map(match => match[1]);
      expect(new Set(secrets).size).toBe(secrets.length);
      await initEnvironment(base);
      expect(await readFile(resolve(base, '.env'), 'utf8')).toBe(first);
      const appPath = resolve(base, 'apps/identity-service/.env');
      await writeFile(appPath, 'DATABASE_URL=postgresql://wrong@localhost/identity_db');
      await expect(initEnvironment(base)).rejects.toThrow('khác root');
      expect(await readFile(appPath, 'utf8')).toContain('wrong');
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it('strips foreign and inherited credentials from app processes', () => {
    const inherited = { PATH: 'tools', IDENTITY_DB_PASSWORD: 'secret', FINANCE_DATABASE_URL: 'secret', PGHOST: 'secret', DATABASE_URL: 'secret', MINIO_ROOT_PASSWORD: 'secret', NODE_OPTIONS: '--require evil' };
    expect(appEnvironment(apps[0], { DATABASE_URL: 'ignored', GATEWAY_PORT: '3000' }, inherited)).toEqual({ PATH: 'tools', GATEWAY_PORT: '3000' });
    expect(appEnvironment(apps[1], { DATABASE_URL: 'own' }, inherited)).toEqual({ PATH: 'tools', DATABASE_URL: 'own' });
  });
  it('verifies every baseline SQL checksum against the committed manifest', async () => {
    for (const service of ['identity', 'trip', 'travel', 'finance', 'automation']) {
      expect((await migrationFiles(service)).map((file: { version: string }) => file.version)).toEqual(['V001']);
    }
  });
  it('refuses modified SQL before connecting to PostgreSQL', async () => {
    const base = await mkdtemp(resolve(tmpdir(), 'wolfari-checksum-test-'));
    try {
      await mkdir(resolve(base, 'docs/database'), { recursive: true });
      await mkdir(resolve(base, 'apps/identity-service/migrations'), { recursive: true });
      await writeFile(resolve(base, 'docs/database/SHA256SUMS.txt'), await readFile(resolve(root, 'docs/database/SHA256SUMS.txt')));
      await writeFile(resolve(base, 'apps/identity-service/migrations/V001.sql'), 'BEGIN; SELECT 1; COMMIT;');
      await expect(migrationFiles('identity', base)).rejects.toThrow('CHECKSUM_MISMATCH');
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
