import { AutomationV1 } from '@wolfari/contracts/grpc';
import { describe, expect, it } from 'vitest';
import {
  channelEnabled,
  normalizeDeviceToken,
  normalizePlatform,
  normalizePreferenceGroups,
  parseStoredGroups,
} from './notification.domain';

describe('notification input rules', () => {
  it('normalizes only declared preference groups with field presence', () => {
    expect(
      normalizePreferenceGroups([
        {
          group: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_INVITATION,
          email: false,
        },
        { group: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PRICE, push: true },
      ]),
    ).toEqual({ INVITATION: { email: false }, PRICE: { push: true } });
    expect(() =>
      normalizePreferenceGroups([
        { group: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PRICE, push: true },
        { group: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PRICE, email: false },
      ]),
    ).toThrowError('VALIDATION_FAILED');
    expect(() =>
      normalizePreferenceGroups([
        { group: AutomationV1.NotificationGroup.NOTIFICATION_GROUP_PLAN },
      ]),
    ).toThrowError('VALIDATION_FAILED');
  });

  it('treats the global channel setting as a kill switch', () => {
    expect(channelEnabled(false, { PRICE: { push: true } }, 'PRICE', 'push')).toBe(false);
    expect(channelEnabled(true, { PRICE: { push: false } }, 'PRICE', 'push')).toBe(false);
    expect(channelEnabled(true, {}, 'PRICE', 'push')).toBe(true);
  });

  it('filters unknown legacy preference data from public projection', () => {
    expect(
      parseStoredGroups({
        PRICE: { push: false, unknown: true },
        INVITATION: { email: true },
        '11111111-1111-4111-8111-111111111111': { email_enabled: false },
      }),
    ).toEqual({ PRICE: { push: false }, INVITATION: { email: true } });
  });

  it('validates opaque device tokens and supported platforms', () => {
    expect(normalizeDeviceToken('device-token-1234567890')).toBe('device-token-1234567890');
    expect(normalizePlatform(AutomationV1.DevicePlatform.DEVICE_PLATFORM_ANDROID)).toBe('ANDROID');
    expect(() => normalizeDeviceToken(' short ')).toThrowError('VALIDATION_FAILED');
    expect(() =>
      normalizePlatform(AutomationV1.DevicePlatform.DEVICE_PLATFORM_UNSPECIFIED),
    ).toThrowError('VALIDATION_FAILED');
  });
});
