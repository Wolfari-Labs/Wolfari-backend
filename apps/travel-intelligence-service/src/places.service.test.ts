import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { DatabaseProvider } from '@wolfari/database';
import { readPlaceSelection } from '@wolfari/common';
import { TravelV1 } from '@wolfari/contracts/grpc';
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

describe('MAP-POI catalogue merge', () => {
  const secret = 's'.repeat(64);
  const poi = (key: string, sim: number, extra: Record<string, unknown> = {}) => ({
    wolfari_key: key,
    tier: 1,
    name_vi: key,
    name_en: null,
    aliases: [],
    category: 'market',
    latitude: 16.068352,
    longitude: 108.224283,
    coord_verified: false,
    address: null,
    typical_duration_min: 60,
    activity_type: 'SHOPPING',
    dress_code_hint: null,
    attribution: '© OpenStreetMap contributors',
    snapshot_at: new Date('2026-11-18T11:26:28Z'),
    sim,
    distance_m: 100,
    ...extra,
  });
  const service = (catalog: unknown[] | Error, fetcher: () => Promise<Response>) => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM poi_snapshots WHERE is_active'))
          return {
            rows: [{ id: 'snap', version: 'golden-test', created_at: new Date('2026-11-18T11:26:28Z'), release: null }],
          };
        if (sql.includes('FROM pois')) {
          if (catalog instanceof Error) throw catalog;
          return { rows: catalog };
        }
        return sql.trimStart().startsWith('SELECT') ? { rows: [] } : { rows: [], rowCount: 1 };
      }),
    };
    vi.stubGlobal('fetch', vi.fn(fetcher));
    return new PlacesService(
      db as unknown as DatabaseProvider,
      new ConfigService({ GEOAPIFY_API_KEY: 'unit-private', PLACE_SELECTION_SECRET: secret }),
    );
  };
  const geoapify = (name: string, lat: number, lon: number) =>
    new Response(
      JSON.stringify({ features: [{ properties: { place_id: `g-${name}`, name, lat, lon } }] }),
    );

  it('returns curated results first with MAP-POI fields; 3 good hits skip Geoapify', async () => {
    const svc = service(
      [
        poi('dn-cho-han', 1, { name_vi: 'Chợ Hàn' }),
        poi('dn-cho-con', 0.5),
        poi('dn-cho-hoi-an', 0.6),
      ],
      async () => geoapify('x', 16, 108),
    );
    const result = await svc.search({ ...request, query: 'cho han' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.meta).toMatchObject({ provider: 'WOLFARI', warnings: [], stale: false });
    expect(result.data![0]).toMatchObject({
      id: 'dn-cho-han',
      name: 'Chợ Hàn',
      provider: 'WOLFARI',
      category: 'market',
      category_label: 'Chợ',
      tier: 1,
      coord_verified: false,
      typical_duration_min: 60,
      activity_type: 'SHOPPING',
      dress_code_hint: '',
      categories: ['market'],
      attribution: '© OpenStreetMap contributors',
    });
    const token = readPlaceSelection(
      result.data![0]!.selection_token!,
      secret,
      request.actor_user_id,
      request.trip_id,
    );
    expect(token.place).toMatchObject({ provider: 'WOLFARI', provider_place_id: 'dn-cho-han' });
  });
  it('appends de-duplicated Geoapify results when fewer than 3 good catalogue hits', async () => {
    const svc = service(
      [poi('dn-cho-han', 1, { name_vi: 'Chợ Hàn' })],
      async () =>
        new Response(
          JSON.stringify({
            features: [
              { properties: { place_id: 'dup', name: 'Cho Han', lat: 16.0684, lon: 108.2243 } },
              { properties: { place_id: 'new', name: 'Han Coffee', lat: 16.07, lon: 108.23 } },
            ],
          }),
        ),
    );
    const result = await svc.search({ ...request, query: 'cho han' });
    expect(result.data!.map((p) => [p.id, p.provider, p.tier])).toEqual([
      ['dn-cho-han', 'WOLFARI', 1],
      ['new', 'GEOAPIFY', 9],
    ]);
    expect(result.data![1]).toMatchObject({ category: '', coord_verified: false });
    expect(result.meta?.provider).toBe('WOLFARI+GEOAPIFY');
  });
  it('keeps catalogue results when Geoapify fails', async () => {
    const svc = service([poi('dn-cau-rong', 0.9)], async () => new Response('', { status: 429 }));
    const result = await svc.search({ ...request, query: 'cau rong' });
    expect(result.data!.map((p) => p.id)).toEqual(['dn-cau-rong']);
    expect(result.meta).toMatchObject({
      provider: 'WOLFARI',
      status: TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS,
      warnings: ['PROVIDER_RATE_LIMITED'],
    });
  });
  it('lists nearby catalogue points without q and only falls back when none', async () => {
    const near = service([poi('dn-cho-han', 0)], async () => geoapify('x', 16, 108));
    expect((await near.search(request)).meta?.provider).toBe('WOLFARI');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const empty = service([], async () => geoapify('Hoi An', 16.0544, 108.2022));
    const result = await empty.search(request);
    expect(result.meta?.provider).toBe('GEOAPIFY');
    expect(result.data).toHaveLength(1);
  });
  it('degrades to Geoapify when the catalogue is unavailable', async () => {
    const svc = service(new Error('relation "pois" does not exist'), async () =>
      geoapify('Hoi An', 16.0544, 108.2022),
    );
    const result = await svc.search({ ...request, query: 'hoi an' });
    expect(result.data!.map((p) => p.provider)).toEqual(['GEOAPIFY']);
  });
  it('caps merged results at 20', async () => {
    const many = Array.from({ length: 20 }, (_, i) => poi(`dn-${i}`, 0.2));
    const svc = service(many, async () => geoapify('extra', 16.1, 108.3));
    expect((await svc.search({ ...request, query: 'x' })).data).toHaveLength(20);
  });
});

describe('POI-OVERTURE search request', () => {
  const box = { min_longitude: 108.1, min_latitude: 16.0, max_longitude: 108.3, max_latitude: 16.1 };
  it('defaults to tourism, restaurant, cafe and accommodation', () => {
    const q = normalizePlaceSearch({ ...request, category: '' });
    expect(q.groups).toEqual(['tourism', 'restaurant', 'cafe', 'accommodation']);
    expect(q.codes).toContain('accommodation');
    expect(q.codes).not.toContain('traveler_service');
  });
  it('accepts every documented group and all', () => {
    expect(normalizePlaceSearch({ ...request, category: 'services' }).codes).toEqual(['traveler_service']);
    expect(normalizePlaceSearch({ ...request, category: 'other' }).geoapify).toBe('');
    expect(normalizePlaceSearch({ ...request, category: 'all' }).groups).toHaveLength(11);
    expect(() => normalizePlaceSearch({ ...request, category: 'bank' })).toThrow('VALIDATION_FAILED');
  });
  it('validates bbox and limit', () => {
    const q = normalizePlaceSearch({ ...request, coordinates: undefined, bbox: box, query: 'ignored' });
    expect(q.bbox).toEqual([108.1, 16.0, 108.3, 16.1]);
    expect(q.query).toBe('');
    expect(q.latitude).toBeCloseTo(16.05);
    for (const bad of [
      { ...box, max_longitude: 110.5 },
      { ...box, min_latitude: 16.2 },
      { ...box, min_longitude: Number.NaN },
    ])
      expect(() => normalizePlaceSearch({ ...request, bbox: bad })).toThrow('VALIDATION_FAILED');
    expect(() => normalizePlaceSearch({ ...request, limit: 301 })).toThrow('VALIDATION_FAILED');
    expect(normalizePlaceSearch({ ...request, limit: 300 }).limit).toBe(300);
  });
  it('bbox exploration never calls Geoapify and reports the snapshot', async () => {
    const fetcher = vi.fn(async () => new Response('{"features":[]}'));
    vi.stubGlobal('fetch', fetcher);
    const db = {
      query: vi.fn(async (sql: string) =>
        sql.includes('FROM poi_snapshots')
          ? { rows: [{ id: 's', version: 'golden-overture-vn-x', created_at: new Date(), release: '2026-10-21.0' }] }
          : { rows: [] },
      ),
    };
    const svc = new PlacesService(
      db as unknown as DatabaseProvider,
      new ConfigService({ GEOAPIFY_API_KEY: 'unit-private', PLACE_SELECTION_SECRET: 's'.repeat(64) }),
    );
    const result = await svc.search({ ...request, bbox: box });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.meta).toMatchObject({
      snapshot_id: 'golden-overture-vn-x',
      data_release: '2026-10-21.0',
      bbox_truncated: false,
    });
  });
});
