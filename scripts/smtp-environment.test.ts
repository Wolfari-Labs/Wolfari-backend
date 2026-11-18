import { describe, expect, it } from 'vitest';
import { apps, appEnvironment } from './config.mjs';

describe('SMTP environment isolation', () => {
  it('passes Gmail credentials/TLS only to Automation and keeps other services isolated', () => {
    const values = { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_REQUIRE_TLS: 'false', SMTP_USER: 'sender@gmail.com', SMTP_PASSWORD: 'test-app-password', SMTP_FROM: 'Wolfari <sender@gmail.com>' };
    const automation = apps.find((app: { name: string }) => app.name === 'automation-service');
    expect(appEnvironment(automation, values)).toMatchObject(values);
    for (const app of apps.filter((value: { name: string }) => value.name !== 'automation-service')) {
      const selected = appEnvironment(app, values);
      expect(selected).not.toHaveProperty('SMTP_PASSWORD');
      expect(selected).not.toHaveProperty('SMTP_USER');
    }
  });
});
