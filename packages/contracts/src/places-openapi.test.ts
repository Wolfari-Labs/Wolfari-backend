import { readFileSync } from 'node:fs';
import { afterEach, it, expect, vi } from 'vitest';
import { PlacesProxy, publicPlace } from '../../../apps/api-gateway/src/places-proxy';
import type { IncomingMessage, ServerResponse } from 'node:http';
const spec = JSON.parse(readFileSync('docs/api/places.openapi.json', 'utf8'));
afterEach(() => vi.unstubAllEnvs());
it('the documented Places search reaches real router auth; no network call', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('GATEWAY_TRIP_SECRET', 's'.repeat(64));
  vi.stubEnv('TRIP_GRPC_TARGET', '127.0.0.1:3202');
  const proxy = new PlacesProxy(async () => {
    throw Error('Must not call upstream without auth');
  });
  let count = 0;
  try {
    for (const [path, methods] of Object.entries(spec.paths))
      for (const method of Object.keys(methods as object)) {
        const request = {
          url: path.replace(/\{[^}]+\}/g, '10000000-0000-4000-8000-000000000001'),
          method: method.toUpperCase(),
          headers: {},
        } as IncomingMessage;
        const output: { statusCode?: number; body?: string } = {};
        const response = Object.assign(output, {
          setHeader() {},
          end(body: string) {
            output.body = body;
          },
        }) as unknown as ServerResponse;
        expect(proxy.matches(request)).toBe(true);
        await proxy.handle(request, response);
        expect(output.statusCode).toBe(401);
        count++;
      }
  } finally {
    proxy.close();
  }
  expect(count).toBe(1);
});
it('MAP-POI Place: gateway fills documented defaults and strips proto-loader virtual keys', () => {
  const schema = spec.components.schemas.Place;
  const documented = Object.keys(schema.properties);
  // proto-loader defaults:false omits '', false, 0 and empty arrays (old Travel or Geoapify rows).
  const geoapify = publicPlace({
    id: 'g-1',
    name: 'Cafe',
    coordinates: { latitude: 16, longitude: 108 },
    selection_token: 't',
    attribution: 'Powered by Geoapify | © OpenStreetMap contributors',
  });
  const wolfari = publicPlace({
    id: 'dn-cho-han',
    name: 'Chợ Hàn',
    coordinates: { latitude: 16.068352, longitude: 108.224283 },
    categories: ['market'],
    selection_token: 't',
    attribution: '© OpenStreetMap contributors',
    provider: 'WOLFARI',
    category: 'market',
    category_label: 'Chợ',
    tier: 1,
    typical_duration_min: 60,
    _typical_duration_min: 'typical_duration_min',
    activity_type: 'SHOPPING',
  });
  for (const place of [geoapify, wolfari]) {
    for (const key of schema.required) expect(place).toHaveProperty(key);
    for (const key of Object.keys(place)) expect(documented).toContain(key);
  }
  expect(geoapify).toMatchObject({ provider: 'GEOAPIFY', tier: 9, coord_verified: false });
  expect(geoapify).not.toHaveProperty('typical_duration_min');
  expect(wolfari).toMatchObject({ provider: 'WOLFARI', tier: 1, typical_duration_min: 60 });
  expect(schema.properties.provider.enum).toEqual(['WOLFARI', 'GEOAPIFY']);
  expect(spec.components.schemas.SearchResponse.properties.meta.properties.provider.enum).toEqual([
    'WOLFARI',
    'GEOAPIFY',
    'WOLFARI+GEOAPIFY',
  ]);
});
