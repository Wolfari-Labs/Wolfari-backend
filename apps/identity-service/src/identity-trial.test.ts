import { generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { DatabaseProvider } from '@wolfari/database';
import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from './identity.service';

describe('Identity trial registration at the service boundary', () => {
  it('rejects non-allowlisted registration before DB/hash and normalizes allowed email', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const query = vi.fn();
    const withTransaction = vi.fn().mockRejectedValue(new Error('TEST_DB_REACHED'));
    const config = new ConfigService({
      NODE_ENV: 'production',
      IDENTITY_REGISTRATION_ALLOWLIST: 'ALICE@example.com',
      IDENTITY_LINK_BASE_URL: 'https://wolfari.thepiece.io.vn',
      IDENTITY_VERIFY_LINK_PATH: '/verify-email',
      IDENTITY_RESET_LINK_PATH: '/reset-password',
      IDENTITY_TOKEN_KEY: 'a'.repeat(64),
      IDENTITY_ACCESS_PRIVATE_KEY: pair.privateKey
        .export({ type: 'pkcs8', format: 'der' })
        .toString('base64'),
      IDENTITY_ACCESS_PUBLIC_KEY: pair.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64'),
    });
    const service = new IdentityService(
      { query, withTransaction } as unknown as DatabaseProvider,
      config,
    );
    await expect(service.register({ email: 'outsider@example.com' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      status: 403,
    });
    expect(withTransaction).not.toHaveBeenCalled();
    await expect(
      service.register({
        email: ' Alice@Example.com ',
        full_name: 'Trial user',
        password: 'Trial-Password-2026!',
      }),
    ).rejects.toThrow('TEST_DB_REACHED');
    expect(withTransaction).toHaveBeenCalledOnce();
  });
});
