import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { encodePayosReturnToken, PAYOS_RETURN_PATH } from '@wolfari/common';
import { handlePayment, paymentRoute, projectPaymentAttempt } from './payment-http';

function request(method: string, path: string, body?: string) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
  };
  stream.method = method;
  stream.url = path;
  stream.headers = body === undefined ? {} : { 'content-type': 'application/json' };
  stream.socket = { remoteAddress: `10.0.0.${Math.floor(Math.random() * 250)}` };
  return stream;
}
function response() {
  const emitter = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    setHeader: (key: string, value: string) => void;
    end: (value?: string) => void;
    headersSent: boolean;
  };
  emitter.statusCode = 200;
  emitter.headers = {};
  emitter.body = '';
  emitter.headersSent = false;
  emitter.setHeader = (key, value) => {
    emitter.headers[key.toLowerCase()] = value;
  };
  emitter.end = (value = '') => {
    emitter.body = value;
    emitter.headersSent = true;
  };
  return emitter;
}
const grpcError = (code: string) =>
  Object.assign(new Error(code), { code: 7, details: JSON.stringify({ code, details: null }) });
async function call(method: string, path: string, body: string | undefined, client: { call: ReturnType<typeof vi.fn> }) {
  const req = request(method, path, body);
  const res = response();
  const url = new URL(path, 'http://gateway');
  await handlePayment(
    req as never,
    res as never,
    url,
    paymentRoute(url.pathname)!,
    vi.fn() as never,
    client as never,
  );
  return res;
}

describe('payOS Gateway routes', () => {
  it('forwards the exact webhook body and always answers payOS with success JSON', async () => {
    const client = { call: vi.fn().mockResolvedValue({}) };
    const body = '{"code":"00","data":{"orderCode":1},"signature":"x"}';
    const ok = await call('POST', '/api/v1/webhooks/payos', body, client);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ success: true });
    expect(client.call).toHaveBeenCalledWith('ReceivePayosWebhook', { body }, expect.any(String));
    client.call.mockRejectedValueOnce(grpcError('PERMISSION_DENIED'));
    expect((await call('POST', '/api/v1/webhooks/payos', body, client)).statusCode).toBe(200);
    client.call.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    expect((await call('POST', '/api/v1/webhooks/payos', body, client)).statusCode).toBe(503);
    expect((await call('POST', '/api/v1/webhooks/payos', '{', client)).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/webhooks/payos', undefined, client)).statusCode).toBe(404);
  });

  it('returns the payer to the app link in the token and nowhere else', async () => {
    const client = { call: vi.fn() };
    const token = encodePayosReturnToken('exp://192.168.1.5:8081/--/fund');
    const paid = await call(
      'GET',
      `${PAYOS_RETURN_PATH}${token}?code=00&id=abc&cancel=false&status=PAID&orderCode=123456789012`,
      undefined,
      client,
    );
    expect(paid.statusCode).toBe(200);
    expect(paid.body).toContain(
      'href="exp://192.168.1.5:8081/--/fund?provider=PAYOS&#38;status=PAID&#38;orderCode=123456789012"',
    );
    expect(paid.headers['content-security-policy']).toContain("default-src 'none'");
    const cancelled = await call('GET', `${PAYOS_RETURN_PATH}${token}?cancel=true&status=CANCELLED`, undefined, client);
    expect(cancelled.body).toContain('status=CANCELLED');
    expect(cancelled.body).toContain('Bạn đã hủy thanh toán.');
    const forged = await call(
      'GET',
      `${PAYOS_RETURN_PATH}${Buffer.from('https://evil.example').toString('base64url')}`,
      undefined,
      client,
    );
    expect(forged.statusCode).toBe(400);
    expect(forged.headers.location).toBeUndefined();
    expect(client.call).not.toHaveBeenCalled();
  });

  it('returns a web payer only to a page on WEB_ORIGIN', async () => {
    const client = { call: vi.fn() };
    const page = encodePayosReturnToken('http://localhost:5273/trips/t1/fund');
    const evil = encodePayosReturnToken('https://evil.example/trips/t1/fund');
    vi.stubEnv('WEB_ORIGIN', 'http://localhost:5273');
    try {
      const paid = await call('GET', `${PAYOS_RETURN_PATH}${page}?status=PAID&orderCode=1`, undefined, client);
      expect(paid.statusCode).toBe(200);
      expect(paid.body).toContain(
        'href="http://localhost:5273/trips/t1/fund?provider=PAYOS&#38;status=PAID&#38;orderCode=1"',
      );
      expect((await call('GET', `${PAYOS_RETURN_PATH}${evil}`, undefined, client)).statusCode).toBe(400);
      vi.stubEnv('WEB_ORIGIN', '');
      expect((await call('GET', `${PAYOS_RETURN_PATH}${page}`, undefined, client)).statusCode).toBe(400);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('publishes payOS attempts only as LIVE links on pay.payos.vn', () => {
    const base = {
      id: '10000000-0000-4000-8000-000000000001',
      contribution_id: '10000000-0000-4000-8000-000000000002',
      amount: '2000',
      currency: 'VND',
      status: 'PENDING',
      needs_reconciliation: false,
      created_at: { seconds: '1800000000', nanos: 0 },
      updated_at: { seconds: '1800000000', nanos: 0 },
    };
    expect(
      projectPaymentAttempt({
        ...base,
        provider: 'PAYOS',
        environment: 'LIVE',
        payment_url: 'https://pay.payos.vn/web/abc',
      }),
    ).toMatchObject({ provider: 'PAYOS', environment: 'LIVE', payment_url: 'https://pay.payos.vn/web/abc' });
    expect(() =>
      projectPaymentAttempt({ ...base, provider: 'PAYOS', environment: 'SANDBOX' }),
    ).toThrow();
    expect(() =>
      projectPaymentAttempt({
        ...base,
        provider: 'PAYOS',
        environment: 'LIVE',
        payment_url: 'https://test-payment.momo.vn/x',
      }),
    ).toThrow();
    expect(
      projectPaymentAttempt({ ...base, provider: 'MOMO_SANDBOX', environment: 'SANDBOX' }),
    ).toMatchObject({ provider: 'MOMO_SANDBOX' });
  });
});
