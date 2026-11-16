import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityProxy } from './identity-proxy';
import { isLoopbackGrpcTarget } from './trip-http';

afterEach(() => vi.unstubAllEnvs());

const targets = [
  ['127.0.0.1:1024', true],
  ['127.0.0.1:3201', true],
  ['127.0.0.1:65535', true],
  ['127.0.0.1:1023', false],
  ['127.0.0.1:65536', false],
  ['127.0.0.1:3.2', false],
  ['127.0.0.1:', false],
  ['localhost:3201', false],
  ['[::1]:3201', false],
  ['0.0.0.0:3201', false],
  ['192.168.1.1:3201', false],
  ['http://127.0.0.1:3201', false],
  ['127.0.0.1:3201/path', false],
  [' 127.0.0.1:3201', false],
] as const;

describe('shared Gateway gRPC target validation', () => {
  it.each(targets)('validates %s as %s', (target, accepted) => {
    expect(isLoopbackGrpcTarget(target)).toBe(accepted);
  });

  it.each(targets)('keeps Identity constructor validation for %s', (target, accepted) => {
    for (const [key, value] of Object.entries({
      NODE_ENV: 'test',
      IDENTITY_HTTP_URL: 'http://127.0.0.1:3101',
      IDENTITY_GRPC_TARGET: target,
      GATEWAY_IDENTITY_SECRET: 's'.repeat(64),
      GATEWAY_CSRF_KEY: 'c'.repeat(64),
      WEB_ORIGIN: 'http://localhost:5173',
      GATEWAY_LOCAL_RATE_LIMIT_MULTIPLIER: '1',
    }))
      vi.stubEnv(key, value);

    if (accepted) {
      const proxy = new IdentityProxy();
      proxy.close();
    } else {
      expect(() => new IdentityProxy()).toThrow('Gateway Identity configuration invalid');
    }
  });
});
