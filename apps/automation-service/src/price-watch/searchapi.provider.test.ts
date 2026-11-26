import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSearchApiFare, parseSearchApiFare } from './searchapi.provider';
import { referencePriceFresh, validateProviderResult } from './price-watch-worker.domain';

const query = { origin: 'SGN', destination: 'HAN', departure_date: '2027-01-12' };
const now = Date.parse('2027-01-01T06:00:00Z');
const envelope = {
  search_metadata: { status: 'Success', created_at: new Date(now).toISOString() },
  search_parameters: {
    currency: 'VND',
    departure_id: 'SGN',
    arrival_id: 'HAN',
    outbound_date: query.departure_date,
    flight_type: 'one_way',
  },
};
const offer = {
  flights: [
    {
      departure_airport: { id: 'SGN', date: query.departure_date },
      arrival_airport: { id: 'HAN' },
    },
  ],
  price: 1500000,
};
afterEach(() => vi.unstubAllGlobals());
describe('SearchApi flight prices', () => {
  it('sends a private key in the header and finds the lowest matching VND fare in both result lists', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        ...envelope,
        best_flights: [offer],
        other_flights: [
          { ...offer, price: 1250000 },
          {
            price: 10,
            flights: [
              {
                departure_airport: { id: 'DAD', date: query.departure_date },
                arrival_airport: { id: 'HAN' },
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    const obs = validateProviderResult(await fetchSearchApiFare(query, 'demo-token', signal));
    expect(obs).toMatchObject({
      price: '1250000',
      currency: 'VND',
      provider: 'SEARCHAPI_GOOGLE_FLIGHTS',
    });
    expect(referencePriceFresh(obs!.provider, obs!.fare_metadata, now)).toBe(true);
    expect(referencePriceFresh(obs!.provider, obs!.fare_metadata, now + 49 * 3600000)).toBe(false);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url.origin).toBe('https://www.searchapi.io');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      departure_id: 'SGN',
      arrival_id: 'HAN',
      outbound_date: query.departure_date,
      currency: 'VND',
      adults: '1',
      flight_type: 'one_way',
    });
    expect(url.toString()).not.toContain('demo-token');
    expect(options).toMatchObject({
      headers: { Authorization: 'Bearer demo-token' },
      signal,
      redirect: 'error',
    });
  });

  it('distinguishes empty search results from invalid responses', () => {
    expect(parseSearchApiFare({ ...envelope, other_flights: [] }, query, now)).toEqual({
      kind: 'NO_RESULT',
    });
    for (const payload of [
      { error: 'no credits' },
      { ...envelope, best_flights: 'invalid' },
      { ...envelope, search_parameters: { ...envelope.search_parameters, currency: 'USD' } },
      { ...envelope, best_flights: [{ ...offer, price: 0 }] },
    ])
      expect(() => parseSearchApiFare(payload, query, now)).toThrow('PROVIDER_RESPONSE_INVALID');
  });
  it.each([
    [401, 'PROVIDER_AUTH_FAILED'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [402, 'PROVIDER_RATE_LIMITED'],
  ])('handles HTTP %i without another request', async (status, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: Number(status) })),
    );
    await expect(
      fetchSearchApiFare(query, 'demo-token', new AbortController().signal),
    ).rejects.toMatchObject({ errorCode: code, transient: false });
  });
});
