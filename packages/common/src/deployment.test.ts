import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  gatewayClientIp,
  productionTransportBlocked,
  productionTransportBlockedFor,
  trialEmails,
  trialSmtpOptions,
  trialSmtpSender,
  validateDeploymentEnvironment,
} from './deployment';

const base = {
  NODE_ENV: 'production',
  WOLFARI_DEPLOYMENT_PROFILE: 'single-host-trial',
  WOLFARI_ISOLATED_ENV: '1',
};
const request = (peer: string, ip?: string) =>
  ({
    socket: { remoteAddress: peer },
    headers: { 'x-real-ip': ip, 'x-forwarded-for': '6.6.6.6' },
  }) as unknown as IncomingMessage;
afterEach(() => vi.unstubAllEnvs());
describe('single host deployment boundary', () => {
  it('permits only verified configured cached-price production worker', () => {
    const enabled = {
      ...base,
      PRICE_WATCH_WORKER_ENABLED: 'true',
      PRICE_WATCH_PROVIDER: 'TRAVELPAYOUTS_CACHE',
      TRAVELPAYOUTS_TOKEN: 'test-only',
      TRAVELPAYOUTS_VND_VERIFIED: 'true',
      DATABASE_URL: 'postgres://automation_app:password@127.0.0.1:5432/automation_db',
      IDENTITY_GRPC_TARGET: '127.0.0.1:3201',
      TRIP_GRPC_TARGET: '127.0.0.1:3202',
      AUTOMATION_IDENTITY_SECRET: 'a'.repeat(64),
      AUTOMATION_TRIP_SECRET: 'b'.repeat(64),
      GATEWAY_AUTOMATION_SECRET: 'c'.repeat(64),
      AUTOMATION_CURSOR_SECRET: 'd'.repeat(64),
      RABBITMQ_URL: 'amqp://app:password@127.0.0.1:5672',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'test',
      SMTP_PASSWORD: 'test',
      SMTP_FROM: 'Wolfari <no-reply@example.com>',
      SMTP_REQUIRE_TLS: 'true',
      AUTOMATION_FINANCE_NOTIFICATION_ENABLED: 'false',
    };
    expect(() => validateDeploymentEnvironment(enabled, 'automation-service')).not.toThrow();
    for (const override of [
      { PRICE_WATCH_PROVIDER: 'MOCK_FLIGHT' },
      { TRAVELPAYOUTS_TOKEN: '' },
      { TRAVELPAYOUTS_VND_VERIFIED: 'false' },
    ])
      expect(() =>
        validateDeploymentEnvironment({ ...enabled, ...override }, 'automation-service'),
      ).toThrow('PRICE_WATCH_PROVIDER');
  });
  it('requires explicit production profile and isolated config', () => {
    expect(productionTransportBlocked({ NODE_ENV: 'production' })).toBe(true);
    expect(productionTransportBlocked(base)).toBe(false);
    expect(productionTransportBlockedFor({ get: (key) => base[key as keyof typeof base] })).toBe(
      false,
    );
    expect(() =>
      validateDeploymentEnvironment({ NODE_ENV: 'production' }, 'export-worker'),
    ).toThrow();
    expect(() =>
      validateDeploymentEnvironment({ ...base, WOLFARI_ISOLATED_ENV: '0' }, 'export-worker'),
    ).toThrow();
    expect(() =>
      validateDeploymentEnvironment({ ...base, NODE_ENV: 'development' }, 'export-worker'),
    ).toThrow();
    expect(() => validateDeploymentEnvironment(base, 'export-worker')).not.toThrow();
    expect(() => validateDeploymentEnvironment(base, 'api-gateway')).toThrow('IDENTITY_HTTP_URL');
  });
  it.each([
    'http://example.org:3101',
    'http://127.0.0.1:3101@evil.test:3101',
    'http://127.0.0.1:3101/path',
    'http://127.0.0.1:3101?x=y',
  ])('rejects remote/ambiguous HTTP target %s', (target) => {
    expect(() =>
      validateDeploymentEnvironment({ ...base, IDENTITY_HTTP_URL: target }, 'export-worker'),
    ).toThrow();
  });
  it.each(['localhost:3201', '0.0.0.0:3201', '127.0.0.1:65536', '127.0.0.1:80', 'service:3201'])(
    'rejects gRPC target %s',
    (target) => {
      expect(() =>
        validateDeploymentEnvironment({ ...base, IDENTITY_GRPC_TARGET: target }, 'export-worker'),
      ).toThrow();
    },
  );
  it.each([
    'postgresql://user:secret@db:5432/identity_db',
    'postgresql://user:secret@127.0.0.1:5432/identity_db?host=evil',
    'http://127.0.0.1:5432/db',
  ])('rejects unsafe DB target %s', (target) => {
    expect(() =>
      validateDeploymentEnvironment({ ...base, DATABASE_URL: target }, 'export-worker'),
    ).toThrow();
  });
  it('validates secrets and public origins without exposing values', () => {
    expect(() =>
      validateDeploymentEnvironment({ ...base, GATEWAY_TRIP_SECRET: 'short' }, 'export-worker'),
    ).toThrow('GATEWAY_TRIP_SECRET');
    for (const origin of [
      'http://wolfari.example.com',
      'https://127.0.0.1',
      'https://wolfari.example.com/',
      'https://wolfari.example.com/path',
    ])
      expect(() =>
        validateDeploymentEnvironment({ ...base, WEB_ORIGIN: origin }, 'export-worker'),
      ).toThrow();
  });
  it('preserves development and test defaults', () => {
    expect(() =>
      validateDeploymentEnvironment({ NODE_ENV: 'test' }, 'identity-service'),
    ).not.toThrow();
    expect(() => validateDeploymentEnvironment({}, 'identity-service')).not.toThrow();
  });
});
describe('trial SMTP', () => {
  const smtp = {
    ...base,
    SMTP_HOST: 'smtp-relay.brevo.com',
    SMTP_PORT: '587',
    SMTP_USER: 'smtp-user',
    SMTP_PASSWORD: 'test-only-password',
    SMTP_REQUIRE_TLS: 'true',
    SMTP_FROM: 'Wolfari <no-reply@wolfari.example.com>',
  };
  const config = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });
  it('requires authenticated STARTTLS and verified certificates', () => {
    expect(trialSmtpOptions(config(smtp))).toMatchObject({
      secure: false,
      requireTLS: true,
      auth: { user: 'smtp-user' },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
    expect(trialSmtpOptions(config({ ...smtp, SMTP_PORT: '465' })).secure).toBe(true);
    expect(trialSmtpSender(config(smtp))).toBe(smtp.SMTP_FROM);
  });
  it.each([{ SMTP_PASSWORD: '' }, { SMTP_REQUIRE_TLS: 'false' }, { SMTP_PORT: '25' }])(
    'fails closed on missing/unsafe config %s',
    (override) => {
      expect(() => trialSmtpOptions(config({ ...smtp, ...override }))).toThrow();
    },
  );
  it('rejects local sender/header injection in production', () => {
    for (const from of [
      'Wolfari <no-reply@wolfari.local>',
      'Wolfari <no-reply@a.com>\r\nBcc: victim@b.com',
    ])
      expect(() => trialSmtpSender(config({ ...smtp, SMTP_FROM: from }))).toThrow();
  });
  it('retains Mailpit in local tests', () => {
    expect(
      trialSmtpOptions(config({ NODE_ENV: 'test', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025' })),
    ).toMatchObject({ requireTLS: false, auth: undefined });
  });
});
describe('trusted edge and registration', () => {
  it('distinguishes clients but ignores spoofed XFF', () => {
    expect(gatewayClientIp(request('127.0.0.1', '1.2.3.4'), base)).toBe('1.2.3.4');
    expect(gatewayClientIp(request('127.0.0.1', '1.2.3.5'), base)).toBe('1.2.3.5');
    expect(() => gatewayClientIp(request('10.0.0.1', '1.2.3.4'), base)).toThrow();
    expect(() => gatewayClientIp(request('127.0.0.1', '1.2.3.4, 1.2.3.5'), base)).toThrow();
    expect(() => gatewayClientIp(request('127.0.0.1'), base)).toThrow();
    expect(gatewayClientIp(request('10.0.0.1', '1.2.3.4'), { NODE_ENV: 'test' })).toBe('10.0.0.1');
  });
  it('uses normalized exact emails, with no wildcard or empty allowlist', () => {
    expect(trialEmails(' Alice@Example.com ,bob@example.com')).toEqual(
      new Set(['alice@example.com', 'bob@example.com']),
    );
    for (const value of ['', undefined, '*', '@example.com', 'a@example.com,'])
      expect(() => trialEmails(value)).toThrow();
    expect(() =>
      trialEmails(Array.from({ length: 21 }, (_, i) => `u${i}@example.com`).join(',')),
    ).toThrow();
  });
});
