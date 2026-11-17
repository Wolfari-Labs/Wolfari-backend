import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Metadata } from '@grpc/grpc-js';
import { TripAccessClient } from '@wolfari/contracts/trip-client';
import { PlacesService, decodeGeoapify, normalizePlaceQuery } from './places.service';

const secret = 'x'.repeat(64),
  id = '10000000-0000-4000-8000-000000000001';
const services: PlacesService[] = [];
function create(key?: string) {
  const service = new PlacesService(
    new ConfigService({
      TRAVEL_TRIP_SECRET: secret,
      GATEWAY_TRAVEL_SECRET: secret,
      GEOAPIFY_API_KEY: key,
    }),
  );
  services.push(service);
  return service;
}
afterEach(() => {
  for (const service of services.splice(0)) service.onApplicationShutdown();
  vi.restoreAllMocks();
});
describe('Travel place search', () => {
  it('validates queries and provider coordinates', () => {
    expect(normalizePlaceQuery(' Da Nang ')).toBe('Da Nang');
    for (const query of ['', 'x'.repeat(201), '\0'])
      expect(() => normalizePlaceQuery(query)).toThrow();
    expect(() =>
      decodeGeoapify({ results: [{ place_id: 'x', formatted: 'x', lat: 100, lon: 0 }] }),
    ).toThrow();
  });
  it('labels missing configuration and provider failures without fabricated prices/places', async () => {
    const fetcher = vi.fn();
    const missing = await create().providerSearch('Danang', fetcher);
    expect(missing.meta?.warnings).toContain('PROVIDER_NOT_CONFIGURED');
    expect(missing.meta?.is_mock).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    const broken = await create('private-key').providerSearch(
      'Danang',
      vi.fn(async () => {
        throw Error('private-key');
      }),
    );
    expect(broken.data).toEqual([]);
    expect(JSON.stringify(broken)).not.toContain('private-key');
    expect(broken.meta?.warnings).toContain('PROVIDER_UNAVAILABLE');
  });
  it('returns bounded attributed results and reuses cache', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        results: [
          { place_id: 'place-1', name: 'Beach', formatted: 'Danang', lat: 16.1, lon: 108.2 },
        ],
      }),
    );
    const service = create('private-key');
    const result = await service.providerSearch('Danang', fetcher);
    expect(result.data?.[0]).toMatchObject({
      name: 'Beach',
      coordinates: { latitude: 16.1, longitude: 108.2 },
    });
    expect(result.meta?.attribution).toHaveLength(2);
    await service.providerSearch('Danang', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('authenticates Gateway and checks membership before consulting provider/cache', async () => {
    const service = create();
    const access = vi.spyOn(TripAccessClient.prototype, 'getAccessContext');
    const provider = vi.spyOn(service, 'providerSearch');
    await expect(
      service.search({ query: 'Danang', actor_user_id: id, trip_id: id }),
    ).rejects.toThrow();
    expect(access).not.toHaveBeenCalled();
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'ApiGateway');
    metadata.set('x-service-secret', secret);
    metadata.set('x-correlation-id', id);
    access.mockResolvedValue({ context: { can_read_trip: false } });
    await expect(
      service.search({ query: 'Danang', actor_user_id: id, trip_id: id }, metadata),
    ).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });
});
