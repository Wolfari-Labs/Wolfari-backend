import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityProxy } from './identity-proxy';

const servers: Server[] = [];
let proxy: IdentityProxy | undefined;
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  proxy?.close();
  proxy = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});
describe('production trial Identity proxy with socket HTTP upstream (not real Identity/DB)', () => {
  it('sets Secure cookie, strips refresh token, enforces CSRF/Origin and separates client rates', async () => {
    const upstream = await listen(
      createServer((req, res) => {
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ data: { access_token: 'test-access', refresh_token: 'test-refresh' } }),
        );
      }),
    );
    for (const [key, value] of Object.entries({
      NODE_ENV: 'production',
      WOLFARI_DEPLOYMENT_PROFILE: 'single-host-trial',
      IDENTITY_HTTP_URL: upstream,
      IDENTITY_GRPC_TARGET: '127.0.0.1:3201',
      GATEWAY_IDENTITY_SECRET: 'x'.repeat(64),
      GATEWAY_CSRF_KEY: 'y'.repeat(64),
      WEB_ORIGIN: 'https://wolfari.thepiece.io.vn',
      GATEWAY_LOCAL_RATE_LIMIT_MULTIPLIER: '1',
    }))
      vi.stubEnv(key, value);
    proxy = new IdentityProxy();
    const gateway = await listen(createServer((req, res) => void proxy!.handle(req, res)));
    const login = (ip: string) =>
      fetch(`${gateway}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'x-real-ip': ip,
          'x-forwarded-for': '9.9.9.9',
          'content-type': 'application/json',
          origin: 'https://wolfari.thepiece.io.vn',
        },
        body: '{}',
      });
    const first = await login('1.2.3.4');
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toContain('; Secure');
    expect(first.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Path=/api/v1/auth');
    expect(((await first.json()) as { data: { refresh_token?: string } }).data.refresh_token).toBeUndefined();
    for (let i = 0; i < 9; i++) {
      const response = await login('1.2.3.4');
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    const limited = await login('1.2.3.4');
    expect(limited.status).toBe(429);
    await limited.body?.cancel();
    const second = await login('1.2.3.5');
    expect(second.status).toBe(200);
    await second.body?.cancel();
    const csrf = await fetch(`${gateway}/api/v1/auth/csrf`, {
      headers: { cookie: 'wolfari_refresh=test-refresh' },
    });
    const token = ((await csrf.json()) as { data: { csrf_token: string } }).data.csrf_token;
    for (const [origin, csrfToken, expected] of [
      ['https://evil.example', token, 403],
      ['https://wolfari.thepiece.io.vn', 'wrong', 403],
      ['https://wolfari.thepiece.io.vn', token, 200],
    ] as const) {
      const response = await fetch(`${gateway}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          origin,
          cookie: 'wolfari_refresh=test-refresh',
          'x-csrf-token': csrfToken,
          'x-real-ip': '1.2.3.5',
        },
        body: '{}',
      });
      expect(response.status).toBe(expected);
      await response.body?.cancel();
    }
  });
});
