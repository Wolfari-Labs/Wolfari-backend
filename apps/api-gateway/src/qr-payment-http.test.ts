import type { IncomingMessage, ServerResponse } from 'node:http';
import { CorrelationMiddleware } from '@wolfari/common';
import { describe, expect, it, vi } from 'vitest';
import { FinanceProxy } from './finance-proxy';
import { qrPaymentRoute } from './qr-payment-http';

const id = '10000000-0000-4000-8000-000000000001';
const input = { request_id: id, amount: '150000', note: 'Thanh toán bữa tối' };
const result = {
  ...input,
  order_id: 'wqr-' + 'a'.repeat(40),
  payment_url: 'https://test-payment.momo.vn/v2/gateway/pay?t=test',
  environment: 'SANDBOX',
  private_key: 'never-expose',
};
function setup() {
  const client = { call: vi.fn().mockResolvedValue(result), close: vi.fn() };
  const session = vi.fn().mockResolvedValue({ user_id: id });
  const proxy = new FinanceProxy(session, client);
  async function invoke(
    body: unknown = input,
    options: { key?: string; authorization?: string; method?: string } = {},
  ) {
    let payload: unknown;
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: (value: string) => {
        payload = JSON.parse(value);
      },
    };
    const request = {
      url: `/api/v1/trips/${id}/qr-payments/momo-sandbox`,
      method: options.method ?? 'POST',
      body,
      headers: {
        authorization: options.authorization ?? 'Bearer fixture',
        'idempotency-key': options.key ?? id,
          'content-type': 'application/json',
      },
    } as unknown as IncomingMessage;
    expect(proxy.matches(request)).toBe(true);
    await new Promise<void>((resolve, reject) =>
      new CorrelationMiddleware().use(request, response as unknown as ServerResponse, () => {
        void proxy.handle(request, response as unknown as ServerResponse).then(() => resolve(), reject);
      }),
    );
    return { status: response.statusCode, payload };
  }
  return { invoke, client, session };
}
describe('QR MoMo Sandbox HTTP', () => {
  it('authenticates and projects only the matching sandbox response', async () => {
    const f = setup(),
      response = await f.invoke();
    expect(response.status).toBe(201);
    expect(f.client.call).toHaveBeenCalledWith(
      'CreateQrSandboxPayment',
      { ...input, actor_user_id: id, trip_id: id },
      expect.any(String),
    );
    expect(JSON.stringify(response.payload)).not.toContain('private_key');
    expect(qrPaymentRoute(`/api/v1/trips/${id}/qr-payments/momo-sandbox/extra`)).toBeUndefined();
  });
  it('rejects invalid auth, methods, keys and extra scanned-account fields before RPC', async () => {
    const f = setup();
    expect((await f.invoke(input, { authorization: '' })).status).toBe(401);
    expect((await f.invoke(input, { method: 'GET' })).status).toBe(404);
    expect((await f.invoke(input, { key: 'different' })).status).toBe(400);
    for (const change of [
      { amount: '999' },
      { amount: '50000001' },
      { note: '' },
      { bank_account: 'private' },
      { note: 'line\nbreak' },
    ])
      expect((await f.invoke({ ...input, ...change })).status).toBe(400);
    expect(f.client.call).not.toHaveBeenCalled();
  });
  it('reports missing provider configuration without a misleading retry flag or private details', async () => {
    const f = setup();
    f.client.call.mockRejectedValueOnce({ details: JSON.stringify({
      code: 'PAYMENT_PROVIDER_NOT_CONFIGURED', details: { secret: 'never-expose' },
    }) });
    const response = await f.invoke();
    expect(response.status).toBe(503);
    expect(response.payload).toMatchObject({ error: { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED', retryable: false, details: null } });
    expect(JSON.stringify(response.payload)).not.toContain('never-expose');
  });
  it('never returns production, mismatched or unsafe provider links', async () => {
    const f = setup();
    for (const change of [
      { amount: '1000' },
      { request_id: 'other' },
      { environment: 'LIVE' },
      { payment_url: 'https://test-payment.momo.vn.evil.test/pay' },
    ]) {
      f.client.call.mockResolvedValueOnce({ ...result, ...change });
      expect((await f.invoke()).status).toBe(503);
    }
  });
});

describe('QR MoMo checkout sandbox HTTP', () => {
  const order = '261125_w' + 'd'.repeat(24);
  const token = Buffer.from('exp://127.0.0.1:8081/--/payment-return').toString('base64url');
  const redirect = `http://192.168.1.5:3000/api/v1/qr-payments/payment-return/${token}`;
  async function call(path: string, client: object, method = 'GET', body?: unknown, authorization = 'Bearer fixture') {
    const proxy = new FinanceProxy(vi.fn().mockResolvedValue({ user_id: id }), client as unknown as ConstructorParameters<typeof FinanceProxy>[1]);
    let payload: unknown;
    const headers: Record<string, unknown> = {};
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      writeHead: vi.fn((status: number, values: Record<string, unknown>) => { response.statusCode = status; Object.assign(headers, values); }),
      end: (value?: string) => { payload = value ? JSON.parse(value) : undefined; },
    };
    const request = { url: path, method, body, headers: { authorization, 'idempotency-key': id, 'content-type': 'application/json' } } as unknown as IncomingMessage;
    expect(proxy.matches(request)).toBe(true);
    await new Promise<void>((resolve, reject) =>
      new CorrelationMiddleware().use(request, response as unknown as ServerResponse, () => {
        void Promise.resolve(proxy.handle(request, response as unknown as ServerResponse)).then(() => resolve(), reject);
      }),
    );
    return { status: response.statusCode, payload, headers };
  }
  it('creates MoMo checkout orders and only accepts MoMo test pay links', async () => {
    const client = { call: vi.fn().mockResolvedValue({ ...input, order_id: order, payment_url: 'https://test-payment.momo.vn/v2/gateway/pay?t=x', environment: 'SANDBOX' }), close: vi.fn() };
    const created = await call(`/api/v1/trips/${id}/qr-payments/momo-checkout`, client, 'POST', { ...input, redirect_url: redirect });
    expect(created.status).toBe(201);
    expect(client.call).toHaveBeenCalledWith('CreateQrSandboxPayment', { ...input, actor_user_id: id, trip_id: id, provider: 'MOMO_CHECKOUT', redirect_url: redirect }, expect.any(String));
    client.call.mockResolvedValueOnce({ ...input, order_id: order, payment_url: 'https://evil.example/x', environment: 'SANDBOX' });
    expect((await call(`/api/v1/trips/${id}/qr-payments/momo-checkout`, client, 'POST', { ...input, redirect_url: redirect })).status).toBe(503);
  });
  it('bounces MoMo results (orderId) back into the app', async () => {
    const ok = await call(`/api/v1/qr-payments/payment-return/${token}?partnerCode=MOMO&orderId=${order}&resultCode=0`, { call: vi.fn(), close: vi.fn() }, 'GET', undefined, '');
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe(`exp://127.0.0.1:8081/--/payment-return?order_id=${order}`);
  });
  it('refuses bounces to anything but the Wolfari app', async () => {
    const evil = Buffer.from('https://evil.example/payment-return').toString('base64url');
    expect((await call(`/api/v1/qr-payments/payment-return/${evil}?orderId=${order}`, { call: vi.fn(), close: vi.fn() }, 'GET', undefined, '')).status).toBe(400);
    expect((await call(`/api/v1/qr-payments/payment-return/${token}?orderId=bad`, { call: vi.fn(), close: vi.fn() }, 'GET', undefined, '')).status).toBe(400);
  });
});
