import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  TravelProxy,
  allowRouteRequest,
  routeRequest,
} from '../../../apps/api-gateway/src/travel-proxy';

const spec = JSON.parse(readFileSync('docs/api/travel-route.openapi.json', 'utf8'));
afterEach(() => vi.unstubAllEnvs());
const point = { latitude: 16.068352, longitude: 108.224283 };

describe('POST /api/v1/travel/route (MAP-POI 4.4)', () => {
  it('documented operation reaches real router auth without a network call', async () => {
    const proxy = new TravelProxy(async () => {
      throw Error('Must not call Identity without a bearer token');
    });
    let count = 0;
    try {
      for (const [path, methods] of Object.entries(spec.paths))
        for (const method of Object.keys(methods as object)) {
          const request = {
            url: path,
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
    expect(proxy.matches({ url: '/api/v1/travel/places', headers: {} } as IncomingMessage)).toBe(
      false,
    );
  });
  it('validates the body exactly as documented', () => {
    expect(routeRequest({ coordinates: [point, point] })).toEqual({
      coordinates: [point, point],
      mode: 2,
    });
    expect(routeRequest({ coordinates: [point, point], mode: 'WALKING' }).mode).toBe(1);
    const schema = spec.components.schemas.RouteRequest;
    expect(schema.properties.coordinates.minItems).toBe(2);
    expect(schema.properties.coordinates.maxItems).toBe(25);
    for (const body of [
      {},
      { coordinates: [point] },
      { coordinates: Array.from({ length: 26 }, () => point) },
      { coordinates: [point, { latitude: '16', longitude: 108 }] },
      { coordinates: [point, { ...point, extra: 1 }] },
      { coordinates: [point, point], mode: 'FLYING' },
      { coordinates: [point, point], other: true },
    ])
      expect(() => routeRequest(body as Record<string, unknown>)).toThrow();
  });
  it('allows 60 requests per minute per user', () => {
    const user = `rate-${Math.random()}`;
    const now = 1_000_000;
    for (let i = 0; i < 60; i++) expect(allowRouteRequest(user, now)).toBe(true);
    expect(allowRouteRequest(user, now)).toBe(false);
    expect(allowRouteRequest(`${user}-other`, now)).toBe(true);
    expect(allowRouteRequest(user, now + 1000)).toBe(true);
  });
});
