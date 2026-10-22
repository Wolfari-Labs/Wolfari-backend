import { describe, expect, it } from 'vitest';
import {
  PriceProviderFailure,
  nextPriceWatchSlot,
  priceWatchSlot,
  retryDelay,
  safeProviderFailure,
  validateProviderResult,
} from './price-watch-worker.domain';

describe('Price Watch worker domain', () => {
  it('uses fixed UTC six-hour slots', () => {
    const slot = priceWatchSlot(new Date('2026-10-22T17:59:59.999Z'));
    expect(slot.toISOString()).toBe('2026-10-22T12:00:00.000Z');
    expect(nextPriceWatchSlot(slot).toISOString()).toBe('2026-10-22T18:00:00.000Z');
  });

  it('uses the approved five bounded retry delays', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([
      10_000,
      30_000,
      120_000,
      300_000,
      900_000,
      undefined,
    ]);
  });

  it('accepts a positive VND quote and whitelisted metadata', () => {
    expect(
      validateProviderResult({
        kind: 'SUCCESS',
        price: '1500000',
        currency: 'VND',
        provider: 'MOCK_FLIGHT',
        fare_metadata: { carrier_code: 'WF', baggage_summary: null },
      }),
    ).toEqual({
      price: '1500000',
      currency: 'VND',
      provider: 'MOCK_FLIGHT',
      fare_metadata: { carrier_code: 'WF', baggage_summary: null },
    });
    expect(validateProviderResult({ kind: 'NO_RESULT' })).toBeNull();
  });

  it('rejects unsafe or malformed provider output without retrying it', () => {
    for (const result of [
      {
        kind: 'SUCCESS',
        price: '0',
        currency: 'VND',
        provider: 'MOCK_FLIGHT',
        fare_metadata: {},
      },
      {
        kind: 'SUCCESS',
        price: '1500000',
        currency: 'VND',
        provider: 'MOCK_FLIGHT',
        fare_metadata: { private_url: 'secret' },
      },
    ]) {
      expect(() => validateProviderResult(result as never)).toThrowError(
        expect.objectContaining({ errorCode: 'PROVIDER_RESPONSE_INVALID', transient: false }),
      );
    }
  });

  it('sanitizes unknown provider exceptions', () => {
    expect(safeProviderFailure(new Error('secret raw response'))).toEqual(
      expect.objectContaining({ errorCode: 'PROVIDER_UNAVAILABLE', transient: true }),
    );
    const known = new PriceProviderFailure('PROVIDER_TIMEOUT', true);
    expect(safeProviderFailure(known)).toBe(known);
  });
});
