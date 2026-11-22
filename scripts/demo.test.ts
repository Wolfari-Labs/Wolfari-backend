import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('upgrades an older demo: fixed overrides are rewritten, secrets kept, trip gets MinIO', async () => {
    const target = await mkdtemp(resolve(tmpdir(), 'wolfari-demo-upgrade-test-'));
    try {
      const options = { target, rootOverrides: infraPorts, appOverrides: appOverrides() };
      await initEnvironment(root, options);
      const gatewayPath = resolve(target, 'apps', 'api-gateway', '.env');
      const tripPath = resolve(target, 'apps', 'trip-workspace-service', '.env');
      const secret = (await readEnv(gatewayPath)).GATEWAY_TRIP_SECRET;
      // Simulate an env file written by an older demo version.
      const stale = (await readFile(gatewayPath, 'utf8')).replace(/^TRAVEL_GRPC_TARGET=.*$/m, () => 'TRAVEL_GRPC_TARGET=127.0.0.1:3203');
      await writeFile(gatewayPath, stale);
      const tripStale = (await readFile(tripPath, 'utf8')).replace(/^MINIO_.*$/gm, () => '');
      await writeFile(tripPath, tripStale);
      await initEnvironment(root, options);
      const gateway = await readEnv(gatewayPath);
      expect(gateway.TRAVEL_GRPC_TARGET).toBe(appOverrides()['api-gateway'].TRAVEL_GRPC_TARGET);
      expect(gateway.GATEWAY_TRIP_SECRET).toBe(secret);
      const trip = await readEnv(tripPath);
      const root_ = await readEnv(resolve(target, '.env'));
      expect(trip.MINIO_ENDPOINT).toBe(`127.0.0.1:${root_.MINIO_API_PORT}`);
      expect(trip.MINIO_ACCESS_KEY).toBe(root_.MINIO_ROOT_USER);
      // POI photos: the travel service reads the same MinIO.
      const travel = await readEnv(resolve(target, 'apps', 'travel-intelligence-service', '.env'));
      expect(travel.MINIO_ENDPOINT).toBe(`127.0.0.1:${root_.MINIO_API_PORT}`);
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
