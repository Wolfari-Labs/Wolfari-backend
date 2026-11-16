import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// JS CLI modules are tested against disposable filesystem configuration, not a live database.
// @ts-expect-error CLI module has no declaration file.
import { checkTrial, initTrial, composeArgs, configDirectory, readTrialApp } from './trial.mjs';
const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});
describe('trial configuration tooling', () => {
  it('generates isolated secrets, refuses overwrites and fails until operator input', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'wolfari-trial-test-'));
    scratch.push(temp);
    const path = join(temp, 'config');
    await initTrial(path);
    await expect(initTrial(path)).rejects.toThrow('NEW_DIRECTORY');
    await expect(checkTrial(path)).rejects.toThrow();
    const identityPath = join(path, 'apps/identity-service/.env');
    const automationPath = join(path, 'apps/automation-service/.env');
    await writeFile(
      identityPath,
      (await readFile(identityPath, 'utf8')).replace(
        'IDENTITY_REGISTRATION_ALLOWLIST=""',
        'IDENTITY_REGISTRATION_ALLOWLIST="tester@example.com"',
      ),
    );
    await writeFile(
      automationPath,
      (await readFile(automationPath, 'utf8'))
        .replace('SMTP_USER=""', 'SMTP_USER="test-login"')
        .replace('SMTP_PASSWORD=""', 'SMTP_PASSWORD="test-only"'),
    );
    const configs = await checkTrial(path);
    expect(configs.size).toBe(7);
    const beforeProvider = await readFile(automationPath, 'utf8');
    const enabledProvider = beforeProvider.replace(
      'PRICE_WATCH_WORKER_ENABLED="false"',
      'PRICE_WATCH_WORKER_ENABLED="true"',
    );
    await writeFile(automationPath, enabledProvider);
    await expect(checkTrial(path)).rejects.toThrow('PRICE_WATCH_PROVIDER');
    const validProvider = enabledProvider
      .replace('TRAVELPAYOUTS_TOKEN=""', 'TRAVELPAYOUTS_TOKEN="unit-only-token"')
      .replace('TRAVELPAYOUTS_VND_VERIFIED="false"', 'TRAVELPAYOUTS_VND_VERIFIED="true"');
    await writeFile(automationPath, validProvider);
    await expect(checkTrial(path)).resolves.toBeInstanceOf(Map);
    await writeFile(
      automationPath,
      validProvider.replace(
        'PRICE_WATCH_PROVIDER="TRAVELPAYOUTS_CACHE"',
        'PRICE_WATCH_PROVIDER="MOCK_FLIGHT"',
      ),
    );
    await expect(checkTrial(path)).rejects.toThrow('PRICE_WATCH_PROVIDER');
    await writeFile(automationPath, beforeProvider);
    expect(configs.get('identity-service').MINIO_ACCESS_KEY).toBe('wolfari_identity');
    const rootEnv = await readFile(join(path, '.env'), 'utf8');
    expect(rootEnv).not.toContain('IDENTITY_ACCESS_PRIVATE_KEY');
    expect(rootEnv).not.toContain('GATEWAY_IDENTITY_SECRET');
    await rename(join(path, '.env'), join(path, '.env.private'));
    expect((await readTrialApp(path, { name: 'identity-service' })).NODE_ENV).toBe('production');
    await rename(join(path, '.env.private'), join(path, '.env'));
    const args = composeArgs(path, ['config', '--quiet']);
    expect(args).toContain('wolfari-trial');
    expect(args).toContain('--env-file');
    const financePath = join(path, 'apps/finance-service/.env');
    const finance = await readFile(financePath, 'utf8');
    await writeFile(financePath, finance.replace('127.0.0.1:9000', '127.0.0.1:9002'));
    await expect(checkTrial(path)).rejects.toThrow('STORAGE_PORT_MISMATCH');
    await writeFile(financePath, finance);
    const gatewayPath = join(path, 'apps/api-gateway/.env');
    await writeFile(
      gatewayPath,
      (await readFile(gatewayPath, 'utf8')).replace('127.0.0.1:3201', '127.0.0.1:3299'),
    );
    await expect(checkTrial(path)).rejects.toThrow('GRPC_PORT_MISMATCH');
  });
  it('rejects relative configuration directories', () =>
    expect(() => configDirectory('relative')).toThrow());
});
