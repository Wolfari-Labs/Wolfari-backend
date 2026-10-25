import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfrastructureModule } from './infrastructure.module';

describe('application environment file isolation', () => {
  let directory: string;
  let app: INestApplicationContext | undefined;
  const fileSecret = 'synthetic-developer-secret-never-use-in-tests';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wolfari-common-env-'));
    const envFilePath = join(directory, '.env');
    await writeFile(
      envFilePath,
      `NODE_ENV=development\nFINANCE_PORT=53104\nGATEWAY_FINANCE_SECRET=${fileSecret}\nWOLFARI_ENV_FILE_PROBE=loaded\n`,
      'utf8',
    );
    for (const key of ['FINANCE_PORT', 'GATEWAY_FINANCE_SECRET', 'WOLFARI_ENV_FILE_PROBE'])
      vi.stubEnv(key, undefined);
    // Substitute only the file location; exercise the real Nest configuration loader.
    const forRoot = ConfigModule.forRoot.bind(ConfigModule);
    vi.spyOn(ConfigModule, 'forRoot').mockImplementation((options) =>
      forRoot({ ...options, envFilePath }),
    );
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function start() {
    app = await NestFactory.createApplicationContext(
      InfrastructureModule.forApp('finance-service'),
      {
        logger: false,
        abortOnError: false,
      },
    );
    return app.get(ConfigService);
  }

  it('cannot fill missing test credentials or ports from a developer file', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const config = await start();
    expect(config.get('NODE_ENV')).toBe('test');
    expect(config.get('FINANCE_PORT')).toBe(3104);
    expect(config.get('WOLFARI_ENV_FILE_PROBE')).toBeUndefined();
    expect(process.env.WOLFARI_ENV_FILE_PROBE).toBeUndefined();
    expect(() => config.getOrThrow('GATEWAY_FINANCE_SECRET')).toThrow('GATEWAY_FINANCE_SECRET');
  });

  it('uses explicit test configuration without loading other developer values', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FINANCE_PORT', '54104');
    vi.stubEnv('GATEWAY_FINANCE_SECRET', 'synthetic-isolated-harness-secret');
    const config = await start();
    expect(config.get('FINANCE_PORT')).toBe(54104);
    expect(config.getOrThrow('GATEWAY_FINANCE_SECRET')).toBe('synthetic-isolated-harness-secret');
    expect(config.get('WOLFARI_ENV_FILE_PROBE')).toBeUndefined();
  });

  it.each(['development', undefined])(
    'preserves local file loading with NODE_ENV=%s',
    async (mode) => {
      vi.stubEnv('NODE_ENV', mode);
      const config = await start();
      expect(config.get('NODE_ENV')).toBe('development');
      expect(config.get('FINANCE_PORT')).toBe(53104);
      expect(config.getOrThrow('GATEWAY_FINANCE_SECRET')).toBe(fileSecret);
      expect(config.get('WOLFARI_ENV_FILE_PROBE')).toBe('loaded');
    },
  );
});
