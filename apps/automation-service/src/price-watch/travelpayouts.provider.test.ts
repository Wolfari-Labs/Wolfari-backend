import { describe, it, expect } from 'vitest';
import { parseTravelpayouts } from './travelpayouts.provider';
import { referencePriceFresh } from './price-watch-worker.domain';
const now = Date.parse('2026-11-12T12:00:00Z');
const query = {
  provider: 'TRAVELPAYOUTS_CACHE',
  origin: 'HAN',
  destination: 'DAD',
  departure_date: '2026-12-12',
} as Parameters<typeof parseTravelpayouts>[1];
const row = {
  origin: 'HAN',
  destination: 'DAD',
  depart_date: '2026-12-12',
  return_date: '',
  trip_class: 0,
  actual: true,
  value: 1234000,
  found_at: '2026-11-12T10:00:00Z',
};
const parse = (data: unknown[], extra = {}) =>
  parseTravelpayouts({ success: true, data, ...extra }, query, true, now);
describe('cached price contract', () => {
  it('keeps integer VND, provenance and cheapest matching returned record', () =>
    expect(parse([{ ...row, value: 2000000 }, row])).toMatchObject({
      kind: 'SUCCESS',
      price: '1234000',
      currency: 'VND',
      provider: 'TRAVELPAYOUTS_CACHE',
      fare_metadata: { data_kind: 'CACHED_REFERENCE', source_freshness: 'FRESH_REFERENCE' },
    }));
  it.each([
    { origin: 'SGN' },
    { destination: 'SGN' },
    { depart_date: '2026-12-13' },
    { return_date: '2026-12-20' },
    { trip_class: 1 },
    { actual: false },
  ])('ignores mismatched record %j', (patch) =>
    expect(parse([{ ...row, ...patch }])).toEqual({ kind: 'NO_RESULT' }),
  );
  it.each([0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1])('rejects invalid price %s', (value) =>
    expect(() => parse([{ ...row, value }])).toThrow(),
  );
  it('refuses unverified currency and explicit currency mismatch', () => {
    expect(() => parseTravelpayouts({ success: true, data: [row] }, query, false, now)).toThrow();
    expect(() => parse([row], { currency: 'USD' })).toThrow();
    expect(() => parse([{ ...row, currency: 'RUB' }])).toThrow();
  });
  it('reports missing results without price zero', () =>
    expect(parse([])).toEqual({ kind: 'NO_RESULT' }));
  it.each([undefined, 'bad', '2026-11-09T00:00:00Z', '2026-11-13T00:00:00Z'])(
    'never alerts for unknown/stale/future source %s',
    (found_at) => {
      const result = parse([{ ...row, found_at }]);
      expect(result.kind).toBe('SUCCESS');
      if (result.kind === 'SUCCESS')
        expect(referencePriceFresh(result.provider, result.fare_metadata, now)).toBe(false);
    },
  );
  it('expired source does not alert', () =>
    expect(
      referencePriceFresh(
        'TRAVELPAYOUTS_CACHE',
        {
          data_kind: 'CACHED_REFERENCE',
          provider_found_at: row.found_at,
          provider_expires_at: '2026-11-12T11:00:00Z',
        },
        now,
      ),
    ).toBe(false));
});
