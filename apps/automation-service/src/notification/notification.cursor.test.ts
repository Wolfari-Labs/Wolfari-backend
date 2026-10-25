import { describe, expect, it } from 'vitest';
import { NotificationCursor } from './notification.cursor';

const userId = '11111111-1111-4111-8111-111111111111';

describe('NotificationCursor', () => {
  const cursor = new NotificationCursor('s'.repeat(32));
  const value = {
    scope: 'NOTIFICATIONS' as const,
    user_id: userId,
    unread: 'UNREAD' as const,
    sort_at: '2026-10-22T00:00:00.000Z',
    id: '22222222-2222-4222-8222-222222222222',
  };

  it('round trips only for the same user and unread filter', () => {
    const encoded = cursor.encode(value);
    expect(cursor.decode(encoded, userId, 'UNREAD')).toEqual(value);
    expect(() => cursor.decode(encoded, userId, 'ALL')).toThrowError('VALIDATION_FAILED');
    expect(() =>
      cursor.decode(encoded, '33333333-3333-4333-8333-333333333333', 'UNREAD'),
    ).toThrowError('VALIDATION_FAILED');
  });

  it('rejects tampering', () => {
    const encoded = cursor.encode(value);
    expect(() => cursor.decode(`${encoded}x`, userId, 'UNREAD')).toThrowError('VALIDATION_FAILED');
  });
});
