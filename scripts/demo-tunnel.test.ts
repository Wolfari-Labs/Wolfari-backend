import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  confirmPayosWebhook,
  createWebhookRelay,
  PAYOS_WEBHOOK_PATH,
  installHint,
  tunnelUrl,
  waitForTunnel,
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

describe('demo payOS tunnel', () => {
  it('relays the payOS webhook path and nothing else new', async () => {
    const seen: string[] = [];
    const gateway = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        seen.push(String(request.url));
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
      });
    });
    const relay = await listen(createWebhookRelay(await listen(gateway)));
    const ok = await fetch(`${relay}${PAYOS_WEBHOOK_PATH}`, { method: 'POST', body: '{"data":{}}' });
    expect(ok.status).toBe(200);
    expect(seen).toEqual([PAYOS_WEBHOOK_PATH]);
    expect((await fetch(`${relay}/api/v1/payments/payos/return/x`)).status).toBe(404);
  });
  it('confirms the webhook with payOS and compares the linked account', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ code: '00', data: { accountNumber: '0123456789', accountName: 'NGUYEN VAN A', shortName: 'MBBank' } }));
    };
    const env = { PAYOS_CLIENT_ID: 'id', PAYOS_API_KEY: 'key', PAYOS_ACCOUNT_NUMBER: '0123 456 789' };
    const result = await confirmPayosWebhook('https://x.trycloudflare.com', env, fetcher);
    expect(result).toMatchObject({ ok: true, matches: true, bank: 'MBBank', accountNumber: '0123456789' });
    expect(calls[0]!.url).toBe('https://api-merchant.payos.vn/confirm-webhook');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ webhookUrl: 'https://x.trycloudflare.com/api/v1/webhooks/payos' });
    expect(await confirmPayosWebhook('https://x', {}, fetcher)).toEqual({ configured: false });
    const refused = async () => new Response(JSON.stringify({ code: '401' }), { status: 401 });
    expect(await confirmPayosWebhook('https://x', env, refused)).toMatchObject({ ok: false, code: '401' });
    expect(
      (await confirmPayosWebhook('https://x', { ...env, PAYOS_ACCOUNT_NUMBER: '999' }, fetcher)).matches,
    ).toBe(false);
  });

  it('waits until the new tunnel answers before payOS probes it', async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = async (url: string) => {
      urls.push(url);
      calls += 1;
      if (calls === 1) throw new Error('getaddrinfo ENOTFOUND');
      return new Response('{}', { status: calls === 2 ? 530 : 200 });
    };
    expect(await waitForTunnel('https://x.trycloudflare.com', fetcher, { delayMs: 0 })).toBe(true);
    expect(calls).toBe(3);
    expect(urls[0]).toBe('https://x.trycloudflare.com/api/v1/webhooks/payos');
    const down = async () => new Response('', { status: 502 });
    expect(await waitForTunnel('https://x', down, { attempts: 2, delayMs: 0 })).toBe(false);
  });
});

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
