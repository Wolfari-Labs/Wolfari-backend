import { describe, expect, it } from 'vitest';
import {
  deviceInput,
  deviceProjection,
  notificationProjection,
  notificationRoute,
  preferenceInput,
  preferenceProjection,
} from './notification-proxy';
import { RequestError } from './trip-http';

const id = '11111111-1111-4111-8111-111111111111';

describe('notification HTTP boundary', () => {
  it('maps only API126 through API131 routes', () => {
    expect(notificationRoute('GET', '/api/v1/me/notification-preferences')).toEqual({
      kind: 'get-preferences',
    });
    expect(notificationRoute('PUT', '/api/v1/me/notification-preferences')).toEqual({
      kind: 'update-preferences',
    });
    expect(notificationRoute('POST', '/api/v1/me/devices')).toEqual({
      kind: 'register-device',
    });
    expect(notificationRoute('DELETE', `/api/v1/me/devices/${id}`)).toEqual({
      kind: 'delete-device',
      id,
    });
    expect(notificationRoute('GET', '/api/v1/me/notifications')).toEqual({
      kind: 'list-notifications',
    });
    expect(notificationRoute('PATCH', `/api/v1/me/notifications/${id}/read`)).toEqual({
      kind: 'mark-read',
      id,
    });
    expect(notificationRoute('GET', '/api/v1/me/reminders')).toBeNull();
  });

  it('strictly maps full preference replacement to protobuf presence', () => {
    expect(
      preferenceInput({
        push_enabled: true,
        email_enabled: false,
        expected_version: 1,
        group_overrides: {
          INVITATION: { email: false },
          PRICE: { push: true, email: false },
        },
      }),
    ).toEqual({
      push_enabled: true,
      email_enabled: false,
      expected_version: 1,
      group_overrides: [
        { group: 1, email: false },
        { group: 6, push: true, email: false },
      ],
    });
    expect(() =>
      preferenceInput({
        push_enabled: true,
        email_enabled: true,
        expected_version: 1,
        group_overrides: { MARKETING: { email: true } },
      }),
    ).toThrowError(RequestError);
    expect(() =>
      preferenceInput({
        push_enabled: true,
        email_enabled: true,
        expected_version: 1,
        group_overrides: { PRICE: {} },
      }),
    ).toThrowError(RequestError);
  });

  it('validates device input and never projects its token', () => {
    const token = 'device-token-1234567890';
    expect(deviceInput({ platform: 'WEB', token })).toEqual({ platform: 3, token });
    const projected = deviceProjection({
      id,
      platform: 3,
      active: true,
      last_seen_at: { seconds: '1792627200', nanos: 0 },
      token,
    });
    expect(projected).toEqual({
      id,
      platform: 'WEB',
      active: true,
      last_seen_at: '2026-10-22T00:00:00.000Z',
    });
    expect(JSON.stringify(projected)).not.toContain(token);
  });

  it('projects fixed preference groups and nullable notification fields', () => {
    expect(
      preferenceProjection({
        push_enabled: true,
        email_enabled: false,
        group_overrides: [{ group: 6, push: false }],
        version: 2,
      }),
    ).toEqual({
      push_enabled: true,
      email_enabled: false,
      group_overrides: { PRICE: { push: false } },
      version: 2,
    });
    expect(
      notificationProjection({
        id,
        type: 'PRICE_ALERT',
        title: 'Giá vé đã giảm',
        body: 'Mở ứng dụng để xem.',
        status: 2,
        created_at: { seconds: '1792627200', nanos: 0 },
      }),
    ).toEqual({
      id,
      type: 'PRICE_ALERT',
      title: 'Giá vé đã giảm',
      body: 'Mở ứng dụng để xem.',
      trip_id: null,
      source_id: null,
      status: 'AVAILABLE',
      created_at: '2026-10-22T00:00:00.000Z',
      read_at: null,
    });
  });
});
