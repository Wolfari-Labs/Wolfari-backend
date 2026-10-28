import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { initEnvironment, root, apps, appEnvironment, readEnv } from './config.mjs';
import { appOverrides, infraPorts, assertOwnedResource } from './demo-config.mjs';
import { randomUUID } from 'node:crypto';
import { requestStop, serveControl } from './demo-control.mjs';

describe('isolated demo configuration', () => {
  it('acknowledges shutdown only after the owned launcher has exited', async () => {
    const manifest = { instanceId: randomUUID(), controlToken: randomUUID() };
    let release!: () => void;
    let entered!: () => void;
    const stopping = new Promise<void>(resolve => { entered = resolve; });
    const exited = new Promise<void>(resolve => { release = resolve; });
    const server = await serveControl(manifest, 'backend', async () => { entered(); await exited; });
    let acknowledged = false;
    try {
      const request = requestStop(manifest, 'backend').then(result => { acknowledged = result; });
      await stopping;
      expect(acknowledged).toBe(false);
      release();
      await request;
      expect(acknowledged).toBe(true);
      expect(await requestStop(manifest, 'backend')).toBe(false);
    } finally { release(); server.close(); }
  });
  it('initializes outside development, retains secrets and isolates each application', async () => {
    const target = await mkdtemp(resolve(tmpdir(), 'wolfari-demo-config-test-'));
    try {
      const options = { target, rootOverrides: infraPorts, appOverrides: appOverrides() };
      await initEnvironment(root, options);
      const before = await readFile(resolve(target, '.env'), 'utf8');
      await initEnvironment(root, options);
      expect(await readFile(resolve(target, '.env'), 'utf8')).toBe(before);
      for (const app of apps) {
        const values = await readEnv(resolve(target, 'apps', app.name, '.env'));
        expect(values[app.portKey]).toBe(String(app.port + 10000));
        const isolated = appEnvironment(app, values, { DATABASE_URL: 'wrong', WEB_ORIGIN: 'wrong', WOLFARI_ISOLATED_ENV: 'wrong' });
        expect(isolated.WOLFARI_ISOLATED_ENV).toBe('1');
        if (app.service) expect(isolated.DATABASE_URL).toContain(':15432/');
        else expect(isolated.DATABASE_URL).toBeUndefined();
        if (app.name !== 'api-gateway') expect(isolated.WEB_ORIGIN).toBeUndefined();
      }
    } finally { await rm(target, { recursive: true, force: true }); }
  });
  it('rejects development volumes, foreign instances and arbitrary volume names', () => {
    const manifest = { instanceId: 'demo-instance' };
    const valid = { Name: 'wolfari-demo_postgres_data', Labels: { 'com.docker.compose.project': 'wolfari-demo', 'io.wolfari.demo.instance': manifest.instanceId } };
    expect(() => assertOwnedResource(valid, manifest, 'volume')).not.toThrow();
    expect(() => assertOwnedResource({ ...valid, Name: 'wolfari_postgres_data' }, manifest, 'volume')).toThrow();
    expect(() => assertOwnedResource(valid, { instanceId: 'other' }, 'volume')).toThrow();
    expect(() => assertOwnedResource({ ...valid, Labels: { ...valid.Labels, 'com.docker.compose.project': 'wolfari' } }, manifest, 'volume')).toThrow();
  });
});
