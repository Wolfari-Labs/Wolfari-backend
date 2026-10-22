import { describe, expect, it } from 'vitest';
import { PriceWatchCursor } from './price-watch.cursor';
import { PriceWatchError } from './price-watch.errors';

describe('PriceWatchCursor', () => {
  const codec = new PriceWatchCursor('x'.repeat(32));
  const value = {
    scope: 'WATCHES' as const,
    parent_id: '11111111-1111-4111-8111-111111111111',
    sort_at: '2026-10-22T00:00:00.000Z',
    id: '22222222-2222-4222-8222-222222222222',
  };

  it('round trips and binds the cursor to its collection', () => {
    const encoded = codec.encode(value);
    expect(codec.decode(encoded, 'WATCHES', value.parent_id)).toEqual(value);
    expect(() => codec.decode(encoded, 'OBSERVATIONS', value.parent_id)).toThrowError(
      PriceWatchError,
    );
  });

  it('rejects tampering', () => {
    const encoded = codec.encode(value);
    expect(() => codec.decode(`${encoded}x`, 'WATCHES', value.parent_id)).toThrowError(
      PriceWatchError,
    );
  });
});
