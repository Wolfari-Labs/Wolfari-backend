import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityClient } from '@wolfari/contracts/identity-client';
import { currentCorrelationId } from '@wolfari/common';

const cookieName = 'wolfari_refresh';
const allowed: Array<[string, RegExp]> = [
  ['POST', /^\/api\/v1\/auth\/(register|login|refresh|logout|email-verifications|email-verifications\/confirm|password-reset-requests|password-resets)$/],
  ['GET', /^\/api\/v1\/auth\/local\/(verify|reset)$/],
  ['GET', /^\/api\/v1\/me(?:\/sessions|\/avatar)?$/],
  ['PATCH', /^\/api\/v1\/me$/],
  ['POST', /^\/api\/v1\/me\/(password-change|avatar)$/],
  ['DELETE', /^\/api\/v1\/me\/sessions\/[0-9a-f-]{36}$/i],
];

function cookie(request: IncomingMessage): string | undefined {
  return request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}

function error(response: ServerResponse, status: number, code: string) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify({ error: { code, message: 'Request could not be completed', details: null, retryable: status === 503 }, meta: { correlation_id: currentCorrelationId() } }));
}

class Limit {
  private readonly entries = new Map<string, { count: number; until: number }>();
  check(key: string, count: number, windowMs: number): boolean {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!current || current.until <= now) { this.entries.set(key, { count: 1, until: now + windowMs }); return true; }
    if (current.count >= count) return false;
    current.count++;
    if (this.entries.size > 10_000) for (const [name, value] of this.entries) if (value.until <= now) this.entries.delete(name);
    return true;
  }
}

export class IdentityProxy {
  private readonly client: IdentityClient;
  private readonly limiter = new Limit();
  private readonly target: string;
  private readonly secret: string;
  private readonly csrfKey: string;
  private readonly origin: string;

  constructor() {
    this.target = process.env.IDENTITY_HTTP_URL ?? '';
    this.secret = process.env.GATEWAY_IDENTITY_SECRET ?? '';
    this.csrfKey = process.env.GATEWAY_CSRF_KEY ?? '';
    this.origin = process.env.WEB_ORIGIN ?? '';
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(this.target) || !this.secret || !this.csrfKey || !this.origin) throw new Error('Gateway Identity configuration invalid');
    if (process.env.NODE_ENV === 'production') throw new Error('Gateway Identity transport requires TLS in production');
    this.client = new IdentityClient(process.env.IDENTITY_GRPC_TARGET ?? '127.0.0.1:3201', 'ApiGateway', this.secret);
  }

  private csrf(refresh: string, nonce: string): string {
    const digest = createHash('sha256').update(refresh).digest('hex');
    return createHmac('sha256', this.csrfKey).update(`${digest}:${nonce}`).digest('base64url');
  }

  private csrfValid(refresh: string, value: string): boolean {
    const [nonce, mac] = value.split('.');
    if (!nonce || !mac || nonce.length > 100 || mac.length > 100) return false;
    const expected = Buffer.from(this.csrf(refresh, nonce));
    const actual = Buffer.from(mac);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private setCookie(response: ServerResponse, value: string) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    response.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=${value ? 30 * 24 * 3600 : 0}${secure}`);
  }

  private async collect(request: IncomingMessage): Promise<Buffer> {
    const parsed = (request as IncomingMessage & { body?: unknown }).body;
    if (parsed !== undefined) return Buffer.from(JSON.stringify(parsed));
    const pieces: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const part = Buffer.from(chunk as Buffer);
      total += part.length;
      if (total > 11 * 1024 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
      pieces.push(part);
    }
    return Buffer.concat(pieces);
  }

  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    const method = request.method ?? '';
    const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (method === 'GET' && path === '/api/v1/auth/csrf') {
      const refresh = cookie(request);
      if (!refresh) return error(response, 401, 'UNAUTHENTICATED');
      const nonce = randomBytes(16).toString('base64url');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ data: { csrf_token: `${nonce}.${this.csrf(refresh, nonce)}` }, meta: { correlation_id: currentCorrelationId() } }));
      return;
    }
    if (!allowed.some(([verb, pattern]) => verb === method && pattern.test(path))) return error(response, 404, 'RESOURCE_NOT_FOUND');
    const clientType = request.headers['x-client-type'] ?? 'web';
    if (clientType !== 'web' && clientType !== 'mobile') return error(response, 400, 'VALIDATION_FAILED');
    const refresh = cookie(request);
    if (clientType === 'mobile' && refresh) return error(response, 400, 'VALIDATION_FAILED');
    if (method !== 'GET' && clientType === 'web' && request.headers.origin && request.headers.origin !== this.origin) return error(response, 403, 'PERMISSION_DENIED');
    if (method !== 'GET' && clientType === 'web' && refresh && ['/api/v1/auth/refresh', '/api/v1/auth/logout'].includes(path)) {
      if (request.headers.origin !== this.origin || typeof request.headers['x-csrf-token'] !== 'string' || !this.csrfValid(refresh, request.headers['x-csrf-token'])) return error(response, 403, 'PERMISSION_DENIED');
    }
    const ip = request.socket.remoteAddress ?? 'unknown';
    const limit = path.includes('password-reset-requests') || path.includes('email-verifications') || path.includes('register') ? [5, 3600_000] : path.includes('login') ? [10, 60_000] : path.includes('refresh') ? [60, 60_000] : [120, 60_000];
    if (!this.limiter.check(`${ip}:${path}`, limit[0]!, limit[1]!)) return error(response, 429, 'RESOURCE_EXHAUSTED');
    const protectedPath = path.startsWith('/api/v1/me') || path === '/api/v1/auth/logout' || path === '/api/v1/auth/email-verifications';
    const bearer = request.headers.authorization;
    if (protectedPath) {
      if (!bearer?.startsWith('Bearer ')) return error(response, 401, 'UNAUTHENTICATED');
      try { await this.client.validateSession({ access_token: bearer.slice(7) }, currentCorrelationId()); }
      catch (cause) { return error(response, (cause as { code?: number }).code === 16 ? 401 : 503, (cause as { code?: number }).code === 16 ? 'UNAUTHENTICATED' : 'SERVICE_UNAVAILABLE'); }
    }
    let body: Buffer | undefined;
    if (method !== 'GET') {
      try { body = await this.collect(request); }
      catch { return error(response, 413, 'VALIDATION_FAILED'); }
    }
    if (path === '/api/v1/auth/refresh') {
      if (clientType === 'web') {
        if (!refresh || (body?.length && body.toString().trim() !== '{}')) return error(response, 400, 'VALIDATION_FAILED');
        body = Buffer.from(JSON.stringify({ refresh_token: decodeURIComponent(refresh) }));
      } else {
        if (!body?.length) return error(response, 400, 'VALIDATION_FAILED');
      }
    }
    if (body?.length && !path.endsWith('/avatar') && !(request.headers['content-type'] ?? '').startsWith('application/json') && path !== '/api/v1/auth/refresh') return error(response, 400, 'VALIDATION_FAILED');
    const headers: Record<string, string> = { 'x-service-secret': this.secret, 'x-correlation-id': currentCorrelationId() ?? '', 'x-client-type': String(clientType) };
    if (bearer) headers.authorization = bearer;
    headers['content-type'] = path === '/api/v1/auth/refresh' && clientType === 'web' ? 'application/json' : String(request.headers['content-type'] ?? 'application/json');
    try {
      const upstream = await fetch(`${this.target}${(request.originalUrl ?? request.url ?? '').replace('/api/v1', '/internal/identity')}`, { method, headers, body, signal: AbortSignal.timeout(20_000) });
      response.statusCode = upstream.status;
      const type = upstream.headers.get('content-type');
      if (type) response.setHeader('Content-Type', type);
      if (['/api/v1/auth/login', '/api/v1/auth/refresh'].includes(path) && upstream.ok) {
        const message = await upstream.json() as { data?: Record<string, unknown> };
        if (clientType === 'web' && typeof message.data?.refresh_token === 'string') {
          this.setCookie(response, message.data.refresh_token);
          delete message.data.refresh_token;
        }
        response.end(JSON.stringify(message));
        return;
      }
      if (path === '/api/v1/auth/logout' && upstream.ok && clientType === 'web') this.setCookie(response, '');
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else error(response, 503, 'SERVICE_UNAVAILABLE');
    }
  }

  close() { this.client.close(); }
}
