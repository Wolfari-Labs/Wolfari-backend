import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createWebhookRelay,
  installHint,
  tunnelUrl,
  webhookAuthModes,
  WEBHOOK_PATH,
  // @ts-expect-error CLI is native ESM JavaScript.
} from './demo-tunnel.mjs';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});
const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe('demo SePay tunnel', () => {
  it('relays only the SePay webhook with its auth headers', async () => {
    const seen: {
      method?: string;
      url?: string;
      headers?: Record<string, unknown>;
      body?: string;
    }[] = [];
    const gateway = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        seen.push({ method: request.method, url: request.url, headers: request.headers, body });
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
      });
    });
    const relay = await listen(createWebhookRelay(await listen(gateway)));

    const ok = await fetch(`${relay}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Apikey test',
        cookie: 'wolfari_access=x',
      },
      body: '{"id":1}',
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: WEBHOOK_PATH, body: '{"id":1}' });
    expect(seen[0]!.headers).toMatchObject({ authorization: 'Apikey test' });
    expect(seen[0]!.headers).not.toHaveProperty('cookie');

    for (const [method, path] of [
      ['GET', WEBHOOK_PATH],
      ['POST', '/api/v1/auth/sign-in'],
      ['GET', '/api/v1/trips'],
    ])
      expect(
        (await fetch(`${relay}${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) }))
          .status,
      ).toBe(404);
    expect(seen).toHaveLength(1);
  });
  it('reports configured auth modes without values, finds the quick-tunnel URL and install hint', () => {
    expect(webhookAuthModes({ BANK_WEBHOOK_SEPAY_API_KEY: ' k ' })).toEqual({
      apiKey: true,
      hmac: false,
    });
    expect(webhookAuthModes({})).toEqual({ apiKey: false, hmac: false });
    expect(tunnelUrl('INF |  https://quiet-river-1234.trycloudflare.com  |')).toBe(
      'https://quiet-river-1234.trycloudflare.com',
    );
    expect(tunnelUrl('INF Starting tunnel')).toBeNull();
    expect(installHint('win32')).toBe('winget install --id Cloudflare.cloudflared -e');
  });
});
