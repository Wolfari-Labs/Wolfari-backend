import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UnreadFilter } from './notification.domain';
import { notificationFail } from './notification.errors';

export interface NotificationCursorValue {
  scope: 'NOTIFICATIONS';
  user_id: string;
  unread: UnreadFilter;
  sort_at: string;
  id: string;
}

export class NotificationCursor {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error('AUTOMATION_CURSOR_SECRET missing');
  }

  encode(value: NotificationCursorValue): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  decode(value: unknown, userId: string, unread: UnreadFilter): NotificationCursorValue {
    if (typeof value !== 'string' || value.length > 1000)
      return notificationFail('VALIDATION_FAILED');
    const [payload, provided, extra] = value.split('.');
    if (!payload || !provided || extra !== undefined) return notificationFail('VALIDATION_FAILED');
    const expected = this.sign(payload);
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right))
      return notificationFail('VALIDATION_FAILED');
    try {
      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as NotificationCursorValue;
      if (
        decoded.scope !== 'NOTIFICATIONS' ||
        decoded.user_id !== userId ||
        decoded.unread !== unread ||
        typeof decoded.sort_at !== 'string' ||
        Number.isNaN(new Date(decoded.sort_at).getTime()) ||
        typeof decoded.id !== 'string'
      )
        return notificationFail('VALIDATION_FAILED');
      return decoded;
    } catch {
      return notificationFail('VALIDATION_FAILED');
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
