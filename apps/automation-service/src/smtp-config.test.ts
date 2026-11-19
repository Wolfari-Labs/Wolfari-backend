import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { smtpConfiguration } from './smtp-config';

describe('SMTP delivery configuration', () => {
  it('preserves local Mailpit without credentials', () => {
    const config = smtpConfiguration(
      new ConfigService({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025' }),
    );
    expect(config.options).toMatchObject({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
      requireTLS: false,
      connectionTimeout: 2000,
      socketTimeout: 5000,
    });
    expect(config.options).not.toHaveProperty('auth');
    expect(config.from).toBe('Wolfari <no-reply@wolfari.local>');
  });
  it('supports Gmail app passwords with verified implicit TLS and a real sender', () => {
    const config = smtpConfiguration(
      new ConfigService({
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_PORT: '465',
        SMTP_USER: 'sender@gmail.com',
        SMTP_PASSWORD: 'test-app-password',
      }),
    );
    expect(config.from).toBe('Wolfari <sender@gmail.com>');
    expect(config.options).toMatchObject({
      secure: true,
      auth: { user: 'sender@gmail.com', pass: 'test-app-password' },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      logger: false,
      debug: false,
    });
  });
  it('requires STARTTLS on port 587 for remote providers and supports a verified from address', () => {
    const config = smtpConfiguration(
      new ConfigService({
        SMTP_HOST: 'smtp.provider.test',
        SMTP_PORT: '587',
        SMTP_USER: 'api',
        SMTP_PASSWORD: 'key',
        SMTP_FROM: 'Wolfari <hello@example.test>',
      }),
    );
    expect(config.options).toMatchObject({ secure: false, requireTLS: true });
    expect(config.from).toBe('Wolfari <hello@example.test>');
  });
  it('rejects missing credentials, invalid sender/header injection and insecure remote SMTP', () => {
    const base = {
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '465',
      SMTP_USER: 'sender@gmail.com',
      SMTP_PASSWORD: 'password',
    };
    for (const change of [
      { SMTP_PASSWORD: '' },
      { SMTP_USER: '' },
      { SMTP_FROM: 'Wolfari <no-reply@wolfari.local>' },
      { SMTP_FROM: 'sender@gmail.com\r\nBcc: victim@example.test' },
      { SMTP_PORT: '0' },
      { SMTP_SECURE: 'invalid' },
      { SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false' },
    ])
      expect(() => smtpConfiguration(new ConfigService({ ...base, ...change }))).toThrow();
  });
});
