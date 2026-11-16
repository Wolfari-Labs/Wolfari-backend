import { readFileSync } from 'node:fs';
import { afterEach, it, expect, vi } from 'vitest';
import { PlacesProxy } from '../../../apps/api-gateway/src/places-proxy';
import type { IncomingMessage, ServerResponse } from 'node:http';
const spec = JSON.parse(readFileSync('docs/api/places.openapi.json', 'utf8'));
afterEach(() => vi.unstubAllEnvs());
it('all three documented Places operations reach real router auth; no network call', async () => {
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
  expect(count).toBe(3);
});
