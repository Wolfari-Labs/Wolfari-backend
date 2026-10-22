import { createHmac, timingSafeEqual } from 'node:crypto';
import { priceWatchFail } from './price-watch.errors';

export interface PriceCursor {
  scope: 'WATCHES' | 'OBSERVATIONS';
  parent_id: string;
  sort_at: string;
  id: string;
}

export class PriceWatchCursor {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error('AUTOMATION_CURSOR_SECRET missing');
  }

  encode(value: PriceCursor): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  decode(value: unknown, scope: PriceCursor['scope'], parentId: string): PriceCursor {
    if (typeof value !== 'string' || value.length > 1000)
      return priceWatchFail('VALIDATION_FAILED');
    const [payload, provided, extra] = value.split('.');
    if (!payload || !provided || extra !== undefined) return priceWatchFail('VALIDATION_FAILED');
    const expected = this.sign(payload);
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right))
      return priceWatchFail('VALIDATION_FAILED');
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PriceCursor;
      if (
        decoded.scope !== scope ||
        decoded.parent_id !== parentId ||
        typeof decoded.sort_at !== 'string' ||
        Number.isNaN(new Date(decoded.sort_at).getTime()) ||
        typeof decoded.id !== 'string'
      )
        return priceWatchFail('VALIDATION_FAILED');
      return decoded;
    } catch {
      return priceWatchFail('VALIDATION_FAILED');
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
