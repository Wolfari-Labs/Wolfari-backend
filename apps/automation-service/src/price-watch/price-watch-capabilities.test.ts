import { describe, expect, it } from 'vitest';
import { providerCapabilities, supportsQuery } from './price-watch-capabilities';

const query = {
  journey_type: 'ONE_WAY' as const,
  cabin_class: 'ECONOMY',
  adults: 1,
  children: 0,
  infants: 0,
  currency: 'VND',
};

describe('price watch capabilities', () => {
  it('real sources compare one-way economy fares for one adult in VND only', () => {
    for (const provider of ['SEARCHAPI_GOOGLE_FLIGHTS', 'TRAVELPAYOUTS_CACHE']) {
      const supported = providerCapabilities(provider);
      expect(supportsQuery(supported, query)).toBe(true);
      for (const change of [
        { journey_type: 'ROUND_TRIP' as const },
        { cabin_class: 'BUSINESS' },
        { adults: 2 },
        { children: 1 },
        { infants: 1 },
        { currency: 'USD' },
      ])
        expect(supportsQuery(supported, { ...query, ...change })).toBe(false);
    }
  });

  it('the development mock compares every combination the domain accepts', () => {
    const mock = providerCapabilities('MOCK_FLIGHT');
    expect(
      supportsQuery(mock, { ...query, journey_type: 'ROUND_TRIP', cabin_class: 'FIRST', adults: 4, children: 3, infants: 2 }),
    ).toBe(true);
    expect(supportsQuery(mock, { ...query, adults: 5, children: 5 })).toBe(false);
  });
});
