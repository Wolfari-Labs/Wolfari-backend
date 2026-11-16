import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { DatabaseProvider } from '@wolfari/database';
import { PlacesService, geoapifyPlaces, normalizePlaceSearch } from './places.service';
const request = {
  actor_user_id: '10000000-0000-4000-8000-000000000001',
  trip_id: '10000000-0000-4000-8000-000000000002',
  query: '',
  coordinates: { latitude: 16.0544, longitude: 108.2022 },
  radius_m: 5000,
};
const item = {
  place_id: 'a'.repeat(600),
  name: 'Hoi An',
  lat: 16.0544,
  lon: 108.2022,
  categories: ['tourism'],
};
afterEach(() => vi.unstubAllGlobals());
describe('Geoapify adapter', () => {
  it('preserves longitude/latitude and long provider IDs without invented metadata', () => {
    const p = geoapifyPlaces({ features: [{ properties: item }] }, '2026-11-12T00:00:00Z')[0];
    expect(p).toMatchObject({
      latitude: 16.0544,
      longitude: 108.2022,
      provider_place_id: item.place_id,
    });
    expect(p).not.toHaveProperty('rating');
  });
  it.each([
    { radius_m: 20001 },
    { radius_m: 1 },
    { radius_m: 1.5 },
    { coordinates: { latitude: 108, longitude: 16 } },
    { category: 'unknown' },
    { geocode: true, query: '' },
  ])('rejects invalid search %j', (patch) =>
    expect(() => normalizePlaceSearch({ ...request, ...patch })).toThrow(),
  );
  it('allows centers outside demo area', () =>
    expect(
      normalizePlaceSearch({ ...request, coordinates: { latitude: 48, longitude: 2 } }).longitude,
    ).toBe(2));
  it('filters malformed coordinates', () =>
    expect(geoapifyPlaces({ results: [{ ...item, lat: NaN }] }, 'now')).toEqual([]));
  it('coalesces identical requests, persists cache and uses lon,lat filter', async () => {
    const db = {
      query: vi.fn(async (sql: string) =>
        sql.startsWith('SELECT') ? { rows: [] } : { rows: [], rowCount: 1 },
      ),
    };
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ features: [{ properties: item }] })),
    );
    vi.stubGlobal('fetch', fetcher);
    const svc = new PlacesService(
      db as unknown as DatabaseProvider,
      new ConfigService({
        GEOAPIFY_API_KEY: 'unit-private',
        PLACE_SELECTION_SECRET: 's'.repeat(64),
      }),
    );
    const [a, b] = await Promise.all([svc.search(request), svc.search(request)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a.data).toHaveLength(1);
    expect(b.data).toHaveLength(1);
    expect(String((fetcher.mock.calls as unknown[][])[0]![0])).toContain(
      'circle%3A108.2022%2C16.0544%2C5000',
    );
  });
  it.each([401, 429, 500])('labels upstream error %s without invented places', async (status) => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status })),
    );
    const svc = new PlacesService(
      db as unknown as DatabaseProvider,
      new ConfigService({
        GEOAPIFY_API_KEY: 'unit-private',
        PLACE_SELECTION_SECRET: 's'.repeat(64),
      }),
    );
    const result = await svc.search(request);
    expect(result.data).toEqual([]);
    expect(result.meta?.warnings).toHaveLength(1);
  });
});
