import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Metadata } from '@grpc/grpc-js';
import type { DatabaseProvider } from '@wolfari/database';
import { TravelV1 } from '@wolfari/contracts/grpc';
import {
  RouteService,
  normalizeRoute,
  osrmBase,
  osrmRoute,
  publicSlot,
  resetPublicSlots,
  ROUTE_TTL_MS,
} from './route.service';
import { RouteController } from './route.grpc';

const hanMarket = { latitude: 16.068352, longitude: 108.224283 };
const dragonBridge = { latitude: 16.061168, longitude: 108.227897 };
const request = {
  coordinates: [hanMarket, dragonBridge],
  mode: TravelV1.RouteMode.ROUTE_MODE_DRIVING,
};
const okBody = {
  code: 'Ok',
  routes: [
    {
      distance: 1234.4,
      duration: 245.6,
      geometry: {
        coordinates: [
          [108.224283, 16.068613],
          [108.2239, 16.0671],
          [108.227897, 16.061168],
        ],
      },
    },
  ],
};
afterEach(() => {
  vi.unstubAllGlobals();
  resetPublicSlots();
});

const service = (cached?: Record<string, unknown>, config: Record<string, string> = {}) => {
  const db = {
    query: vi.fn(async (sql: string) =>
      sql.startsWith('SELECT') ? { rows: cached ? [cached] : [] } : { rows: [], rowCount: 1 },
    ),
  };
  return {
    db,
    svc: new RouteService(
      db as unknown as DatabaseProvider,
      new ConfigService({ OSRM_URL: 'http://127.0.0.1:5001', ...config }),
    ),
  };
};

describe('route input', () => {
  it.each([
    { coordinates: [hanMarket] },
    { coordinates: Array.from({ length: 26 }, () => hanMarket) },
    { coordinates: [hanMarket, { latitude: 48.85, longitude: 2.35 }] },
    { coordinates: [hanMarket, { latitude: Number.NaN, longitude: 108 }] },
    { coordinates: [hanMarket, dragonBridge], mode: 99 },
  ])('rejects %j', (patch) =>
    expect(() => normalizeRoute({ ...request, ...patch } as TravelV1.GetRouteRequest)).toThrow(
      'VALIDATION_FAILED',
    ),
  );
  it('rounds to 5 decimals and treats UNSPECIFIED as driving', () =>
    expect(normalizeRoute({ coordinates: [hanMarket, dragonBridge] })).toEqual({
      points: [
        { latitude: 16.06835, longitude: 108.22428 },
        { latitude: 16.06117, longitude: 108.2279 },
      ],
      profile: 'DRIVING',
    }));
  it('maps WALKING and CYCLING to their own profiles', () => {
    expect(
      normalizeRoute({ ...request, mode: TravelV1.RouteMode.ROUTE_MODE_WALKING }).profile,
    ).toBe('WALKING');
    expect(
      normalizeRoute({ ...request, mode: TravelV1.RouteMode.ROUTE_MODE_CYCLING }).profile,
    ).toBe('CYCLING');
  });
});

describe('OSRM base per profile', () => {
  const config = (values: Record<string, string>) => new ConfigService(values);
  it('uses the per-profile URLs and adds a trailing slash', () => {
    const values = {
      OSRM_URL: 'http://127.0.0.1:5001',
      OSRM_WALKING_URL: 'http://127.0.0.1:5002/',
    };
    expect(osrmBase(config(values), 'DRIVING')).toBe('http://127.0.0.1:5001/');
    expect(osrmBase(config(values), 'WALKING')).toBe('http://127.0.0.1:5002/');
    expect(osrmBase(config(values), 'CYCLING')).toBeUndefined();
  });
  it('switches every profile to the public demo servers outside production only', () => {
    const demo = { OSRM_PUBLIC_DEMO: 'true', OSRM_URL: 'http://127.0.0.1:5001' };
    expect(osrmBase(config(demo), 'DRIVING')).toBe('https://router.project-osrm.org/');
    expect(osrmBase(config(demo), 'WALKING')).toBe('https://routing.openstreetmap.de/routed-foot/');
    expect(osrmBase(config(demo), 'CYCLING')).toBe('https://routing.openstreetmap.de/routed-bike/');
    expect(osrmBase(config({ ...demo, NODE_ENV: 'production' }), 'DRIVING')).toBe(
      'http://127.0.0.1:5001/',
    );
    expect(osrmBase(config({ ...demo, NODE_ENV: 'production' }), 'WALKING')).toBeUndefined();
  });
  it('spaces public calls 1.1 s apart and refuses to queue longer than 1.5 s', async () => {
    const sleep = vi.fn(async () => undefined);
    await publicSlot('router.project-osrm.org', 0, sleep);
    await publicSlot('router.project-osrm.org', 0, sleep);
    expect(sleep).toHaveBeenCalledWith(1100);
    await expect(publicSlot('router.project-osrm.org', 0, sleep)).rejects.toThrow(
      'PROVIDER_RATE_LIMITED',
    );
    await publicSlot('127.0.0.1', 0, sleep);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('OSRM adapter', () => {
  it('converts lon,lat GeoJSON into latitude/longitude geometry', () =>
    expect(osrmRoute(okBody)).toEqual({
      distance_m: 1234,
      duration_seconds: 246,
      geometry: [
        { latitude: 16.068613, longitude: 108.224283 },
        { latitude: 16.0671, longitude: 108.2239 },
        { latitude: 16.061168, longitude: 108.227897 },
      ],
    }));
  it('maps NoRoute to no result and rejects malformed payloads', () => {
    expect(osrmRoute({ code: 'NoRoute' })).toBeNull();
    expect(() => osrmRoute({ code: 'Ok', routes: [] })).toThrow('PROVIDER_RESPONSE_INVALID');
  });
  it('decimates very long geometries but keeps the last point', () => {
    const coordinates = Array.from({ length: 10001 }, (_, i) => [108 + i / 1e5, 16]);
    const route = osrmRoute({
      code: 'Ok',
      routes: [{ distance: 1, duration: 1, geometry: { coordinates } }],
    });
    expect(route!.geometry.length).toBeLessThanOrEqual(4001);
    expect(route!.geometry.at(-1)).toEqual({ latitude: 16, longitude: 108.1 });
  });
});

describe('RouteService', () => {
  it('calls OSRM car profile with lon,lat order, caches 7 days and labels the estimate', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(okBody)));
    vi.stubGlobal('fetch', fetcher);
    const { svc, db } = service();
    const result = await svc.route(request);
    const url = String((fetcher.mock.calls as unknown[][])[0]![0]);
    expect(url).toBe(
      'http://127.0.0.1:5001/route/v1/driving/108.22428,16.06835;108.2279,16.06117?overview=full&geometries=geojson',
    );
    expect(result.data).toMatchObject({ distance_m: 1234, duration_seconds: 246 });
    expect(result.meta).toMatchObject({
      status: TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS,
      provider: 'OSRM',
      stale: false,
      warnings: ['ESTIMATED_BY_CAR_PROFILE'],
    });
    const insert = db.query.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT'),
    ) as unknown as [string, [string, string, string, Date, Date]];
    expect(insert[1][4].getTime() - insert[1][3].getTime()).toBe(ROUTE_TTL_MS);
  });
  it('serves a fresh cache without calling OSRM', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { svc } = service({
      payload: osrmRoute(okBody),
      status: 'SUCCESS',
      fetched_at: new Date(),
      expires_at: new Date(Date.now() + 60000),
    });
    expect((await svc.route(request)).data?.distance_m).toBe(1234);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns stale cached road geometry when OSRM is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const { svc } = service({
      payload: osrmRoute(okBody),
      status: 'SUCCESS',
      fetched_at: new Date(Date.now() - 8 * 86400000),
      expires_at: new Date(Date.now() - 86400000),
    });
    const result = await svc.route(request);
    expect(result.meta).toMatchObject({
      stale: true,
      warnings: ['ESTIMATED_BY_CAR_PROFILE', 'PROVIDER_UNAVAILABLE'],
    });
  });
  it.each([
    [
      'unreachable',
      {},
      async () => Promise.reject(new Error('ECONNREFUSED')),
      'PROVIDER_UNAVAILABLE',
    ],
    ['not configured', { OSRM_URL: '' }, async () => new Response('{}'), 'PROVIDER_NOT_CONFIGURED'],
  ])('reports %s as an error without data', async (_, config, fetcher, code) => {
    vi.stubGlobal('fetch', vi.fn(fetcher));
    const result = await service(undefined, config).svc.route(request);
    expect(result.data).toBeUndefined();
    expect(result.meta).toMatchObject({
      status: TravelV1.ProviderStatus.PROVIDER_STATUS_ERROR,
      warnings: [code],
    });
  });
  it('returns OpenStreetMap attribution with every road route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(okBody))),
    );
    const result = await service().svc.route(request);
    expect(result.meta?.attribution).toEqual([
      { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
      { text: 'Góp ý sửa bản đồ', url: 'https://www.openstreetmap.org/fixthemap' },
    ]);
  });
  it('routes WALKING with its own server, cache key and no car-estimate warning', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(okBody)));
    vi.stubGlobal('fetch', fetcher);
    const walking = service(undefined, { OSRM_WALKING_URL: 'http://127.0.0.1:5002' });
    const result = await walking.svc.route({
      ...request,
      mode: TravelV1.RouteMode.ROUTE_MODE_WALKING,
    });
    expect(String((fetcher.mock.calls as unknown[][])[0]![0])).toBe(
      'http://127.0.0.1:5002/route/v1/foot/108.22428,16.06835;108.2279,16.06117?overview=full&geometries=geojson',
    );
    expect(result.meta).toMatchObject({
      status: TravelV1.ProviderStatus.PROVIDER_STATUS_SUCCESS,
      warnings: [],
    });
    const driving = service();
    await driving.svc.route(request);
    const key = (db: typeof walking.db) =>
      (
        db.query.mock.calls.find(([sql]) => String(sql).startsWith('INSERT')) as unknown as [
          string,
          string[],
        ]
      )[1][0];
    expect(key(walking.db)).not.toBe(key(driving.db));
  });
  it('sends a descriptive User-Agent to the public CYCLING server', async () => {
    const fetcher = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(okBody)),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await service(undefined, { OSRM_PUBLIC_DEMO: 'true' }).svc.route({
      ...request,
      mode: TravelV1.RouteMode.ROUTE_MODE_CYCLING,
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(
      /^https:\/\/routing\.openstreetmap\.de\/routed-bike\/route\/v1\/bike\//,
    );
    expect((init?.headers as Record<string, string>)['User-Agent']).toMatch(/^Wolfari\/1\.0 \(/);
    expect(result.data?.distance_m).toBe(1234);
  });
  it('does not route WALKING with the car profile', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await service().svc.route({
      ...request,
      mode: TravelV1.RouteMode.ROUTE_MODE_WALKING,
    });
    expect(result.meta?.warnings).toEqual(['PROVIDER_NOT_CONFIGURED']);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('caches NoRoute as NO_RESULT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 'NoRoute' }), { status: 400 })),
    );
    const result = await service().svc.route(request);
    expect(result.meta?.status).toBe(TravelV1.ProviderStatus.PROVIDER_STATUS_NO_RESULT);
  });
});

it('GetRoute rejects callers other than the API Gateway before routing', async () => {
  const route = vi.fn(async () => ({}));
  const controller = new RouteController(
    { route } as unknown as RouteService,
    new ConfigService({ GATEWAY_TRAVEL_SECRET: 's'.repeat(64) }),
  );
  const metadata = new Metadata();
  metadata.set('x-caller-service', 'ApiGateway');
  metadata.set('x-service-secret', 'wrong');
  await expect(controller.getRoute(request, metadata)).rejects.toThrow();
  expect(route).not.toHaveBeenCalled();
  metadata.set('x-service-secret', 's'.repeat(64));
  await expect(controller.getRoute(request, metadata)).resolves.toEqual({});
});
