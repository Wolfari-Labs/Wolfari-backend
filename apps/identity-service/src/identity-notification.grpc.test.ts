import 'reflect-metadata';
import { Metadata, status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { describe, expect, it, vi } from 'vitest';
import { IdentityGrpcController } from './identity.grpc';
import { NotificationEligibilityValidationError } from './notification-eligibility.service';

const userId = '10000000-0000-4000-8000-000000000001';
const correlation = '20000000-0000-4000-8000-000000000002';
const secret = 'synthetic-automation-identity-secret';
function metadata() {
  const value = new Metadata();
  value.set('x-caller-service', 'Automation');
  value.set('x-service-secret', secret);
  value.set('x-correlation-id', correlation);
  return value;
}
function setup(expected: unknown = secret) {
  const get = vi.fn().mockResolvedValue({ recipients: [{ user_id: userId, eligible: true }] });
  const profiles = vi.fn().mockResolvedValue({ profiles: [] });
  const config = {
    get: vi.fn((name: string) =>
      name === 'AUTOMATION_IDENTITY_SECRET' ? expected : 'synthetic-trip-identity-secret-0000',
    ),
  };
  const controller = new IdentityGrpcController(
    { profiles } as never,
    config as never,
    { get } as never,
  );
  return { get, profiles, config, controller };
}
async function expectError(pending: Promise<unknown>, code: number, message: string) {
  let failure: unknown;
  try {
    await pending;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RpcException);
  expect((failure as RpcException).getError()).toEqual({ code, message });
}

describe('Automation-only notification eligibility RPC', () => {
  it('returns only eligibility and delegates the exact requested batch after authentication', async () => {
    const s = setup(),
      request = { user_ids: [userId] };
    expect(await s.controller.getNotificationEligibility(request, metadata())).toEqual({
      recipients: [{ user_id: userId, eligible: true }],
    });
    expect(s.get).toHaveBeenCalledExactlyOnceWith(request.user_ids);
    expect(s.profiles).not.toHaveBeenCalled();
  });

  it.each([
    'ApiGateway',
    'Trip',
    'Finance',
    'Travel',
    'ExportWorker',
    'Unknown',
    'automation',
    'Automation ',
  ])('rejects caller %s even with the correct Automation secret', async (caller) => {
    const s = setup(),
      headers = metadata();
    headers.set('x-caller-service', caller);
    await expectError(
      s.controller.getNotificationEligibility({ user_ids: [userId] }, headers),
      status.PERMISSION_DENIED,
      'Caller is not authorized',
    );
    expect(s.get).not.toHaveBeenCalled();
  });

  it('rejects omitted metadata before any eligibility read', async () => {
    const s = setup();
    await expectError(
      s.controller.getNotificationEligibility({ user_ids: [userId] }),
      status.PERMISSION_DENIED,
      'Caller is not authorized',
    );
    expect(s.get).not.toHaveBeenCalled();
  });

  it.each(['x-caller-service', 'x-service-secret', 'x-correlation-id'])(
    'rejects missing %s',
    async (key) => {
      const s = setup(),
        headers = metadata();
      headers.remove(key);
      await expectError(
        s.controller.getNotificationEligibility({ user_ids: [userId] }, headers),
        status.PERMISSION_DENIED,
        'Caller is not authorized',
      );
      expect(s.get).not.toHaveBeenCalled();
    },
  );

  it.each(['x-caller-service', 'x-service-secret', 'x-correlation-id'])(
    'rejects repeated %s even when both values match',
    async (key) => {
      const s = setup(),
        headers = metadata();
      headers.add(key, headers.get(key)[0]!);
      await expectError(
        s.controller.getNotificationEligibility({ user_ids: [userId] }, headers),
        status.PERMISSION_DENIED,
        'Caller is not authorized',
      );
      expect(s.get).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'wrong', 'x'.repeat(secret.length), 'synthetic-trip-identity-secret-0000'])(
    'rejects a mismatched supplied secret (%s)',
    async (value) => {
      const s = setup(),
        headers = metadata();
      headers.set('x-service-secret', value);
      await expectError(
        s.controller.getNotificationEligibility({ user_ids: [userId] }, headers),
        status.PERMISSION_DENIED,
        'Caller is not authorized',
      );
      expect(s.get).not.toHaveBeenCalled();
    },
  );

  it.each([null, '', 'x'.repeat(31), 123, Buffer.from(secret)])(
    'rejects absent, short or malformed configured credentials (%s)',
    async (expected) => {
      const s = setup(expected);
      await expectError(
        s.controller.getNotificationEligibility({ user_ids: [userId] }, metadata()),
        status.PERMISSION_DENIED,
        'Caller is not authorized',
      );
      expect(s.get).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'invalid', correlation + ', ' + correlation, ' ' + correlation, correlation + '\n'])(
    'rejects invalid correlation metadata (%s)',
    async (value) => {
      const s = setup(),
        headers = metadata();
      const malformed = {
        get: (name: string) => (name === 'x-correlation-id' ? [value] : headers.get(name)),
      };
      await expectError(
        s.controller.getNotificationEligibility({ user_ids: [userId] }, malformed as never),
        status.PERMISSION_DENIED,
        'Caller is not authorized',
      );
      expect(s.get).not.toHaveBeenCalled();
    },
  );

  it.each(['x-caller-service', 'x-service-secret', 'x-correlation-id'])(
    'rejects a binary %s value instead of coercing it to a string',
    async (key) => {
      const s = setup(),
        headers = metadata();
      const malformed = {
        get: (name: string) =>
          name === key ? [Buffer.from(String(headers.get(name)[0]))] : headers.get(name),
      };
      await expectError(
        s.controller.getNotificationEligibility({ user_ids: [userId] }, malformed as never),
        status.PERMISSION_DENIED,
        'Caller is not authorized',
      );
      expect(s.get).not.toHaveBeenCalled();
    },
  );

  it('maps invalid input to INVALID_ARGUMENT without including submitted values', async () => {
    const s = setup();
    s.get.mockRejectedValue(new NotificationEligibilityValidationError());
    await expectError(
      s.controller.getNotificationEligibility({ user_ids: ['private-invalid-input'] }, metadata()),
      status.INVALID_ARGUMENT,
      'VALIDATION_FAILED',
    );
  });

  it.each([
    new Error('secret=private database failure'),
    new TypeError('private malformed result'),
    null,
  ])('maps dependency failures to a generic UNAVAILABLE result', async (failure) => {
    const s = setup();
    s.get.mockRejectedValue(failure);
    await expectError(
      s.controller.getNotificationEligibility({ user_ids: [userId] }, metadata()),
      status.UNAVAILABLE,
      'Identity temporarily unavailable',
    );
  });

  it('rejects an unconfigured Automation secret', async () => {
    const s = setup();
    s.config.get.mockReturnValue(undefined);
    await expectError(
      s.controller.getNotificationEligibility({ user_ids: [userId] }, metadata()),
      status.PERMISSION_DENIED,
      'Caller is not authorized',
    );
    expect(s.get).not.toHaveBeenCalled();
  });

  it('does not broaden the existing GetProfiles caller allowlist', async () => {
    const s = setup();
    expect(() => s.controller.getProfiles({ user_ids: [userId] }, metadata())).toThrow(
      RpcException,
    );
    expect(s.profiles).not.toHaveBeenCalled();
    const headers = metadata();
    headers.set('x-caller-service', 'Trip');
    headers.set('x-service-secret', 'synthetic-trip-identity-secret-0000');
    expect(await s.controller.getProfiles({ user_ids: [userId] }, headers)).toEqual({
      profiles: [],
    });
  });
});
