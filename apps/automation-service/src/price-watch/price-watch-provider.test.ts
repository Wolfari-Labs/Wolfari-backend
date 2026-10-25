import { describe, expect, it } from 'vitest';
import { MockFlightPriceProvider } from './price-watch-provider';

const query = {
  provider: 'MOCK_FLIGHT' as const,
  transport_type: 'FLIGHT' as const,
  origin: 'DAD',
  destination: 'SGN',
  departure_date: '2099-11-01',
  return_date: null,
  journey_type: 'ONE_WAY' as const,
  adults: 1,
  children: 0,
  infants: 0,
  passenger_count: 1,
  cabin_class: 'ECONOMY' as const,
  currency: 'VND' as const,
  departure_at: '2099-11-01T02:00:00.000Z',
};

describe('MockFlightPriceProvider', () => {
  it('returns the same clearly marked quote for the same group and slot', async () => {
    const provider = new MockFlightPriceProvider();
    const request = {
      canonicalKey: 'canonical',
      scheduledSlot: '2026-10-22T12:00:00.000Z',
      query,
      signal: new AbortController().signal,
    };
    const first = await provider.fetch(request);
    expect(await provider.fetch(request)).toEqual(first);
    expect(first).toEqual(
      expect.objectContaining({
        kind: 'SUCCESS',
        currency: 'VND',
        provider: 'MOCK_FLIGHT',
        fare_metadata: expect.objectContaining({ baggage_summary: 'MOCK_DATA' }),
      }),
    );
  });

  it('fails before work when the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new MockFlightPriceProvider().fetch({
        canonicalKey: 'canonical',
        scheduledSlot: '2026-10-22T12:00:00.000Z',
        query,
        signal: controller.signal,
      }),
    ).rejects.toEqual(expect.objectContaining({ errorCode: 'PROVIDER_TIMEOUT' }));
  });
});
