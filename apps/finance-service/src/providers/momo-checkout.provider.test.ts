import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MomoCheckoutProvider } from './momo-checkout.provider';

const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const input = {
  orderId: '251125_w' + 'a'.repeat(24),
  requestId: '10000000-0000-4000-8000-000000000001',
  amount: 20000n,
  orderInfo: 'Wolfari - Ca phe',
  redirectUrl: 'http://192.168.1.5:3000/api/v1/qr-payments/payment-return/ZXhwOi8vMTI3LjAuMC4x',
};
const setup = (values: Record<string, string>, body: unknown) => {
  const fetcher = vi.fn().mockResolvedValue(reply(body));
  return { fetcher, provider: new MomoCheckoutProvider(new ConfigService(values), fetcher as unknown as typeof fetch) };
};

describe('MoMo checkout sandbox provider', () => {
  it('is off unless enabled, and the mock is test-only', () => {
    expect(new MomoCheckoutProvider(new ConfigService({})).ready()).toBe(false);
    expect(() => new MomoCheckoutProvider(new ConfigService({ MOMO_CHECKOUT_MODE: 'mock', NODE_ENV: 'development' })).mode()).toThrow();
  });
  it('signs a payWithMethod order with the documented raw signature', async () => {
    const { provider, fetcher } = setup({ MOMO_CHECKOUT_MODE: 'remote' }, { resultCode: 0, message: 'Thành công.', payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=x' });
    expect(await provider.create(input)).toEqual({ resultCode: 0, message: 'Thành công.', payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=x' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://test-payment.momo.vn/v2/gateway/api/create');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ partnerCode: 'MOMO', requestType: 'payWithMethod', amount: 20000, redirectUrl: input.redirectUrl, ipnUrl: 'https://momo.vn' });
    const raw = `accessKey=F8BBA842ECF85&amount=20000&extraData=&ipnUrl=https://momo.vn&orderId=${input.orderId}&orderInfo=${input.orderInfo}` +
      `&partnerCode=MOMO&redirectUrl=${input.redirectUrl}&requestId=${input.requestId}&requestType=payWithMethod`;
    expect(body.signature).toBe(createHmac('sha256', 'K951B6PE1waDMi640xX08PD3vg6EkVlz').update(raw).digest('hex'));
  });
  it('refuses pay links outside the MoMo test gateway and reads the order status', async () => {
    await expect(setup({ MOMO_CHECKOUT_MODE: 'remote' }, { resultCode: 0, payUrl: 'https://evil.example/pay' }).provider.create(input)).rejects.toThrow('MOMO_RESPONSE_URL');
    const { provider } = setup({ MOMO_CHECKOUT_MODE: 'remote' }, { resultCode: 0, amount: 20000, transId: 4088878653 });
    expect(await provider.query(input.orderId, input.requestId)).toEqual({ resultCode: 0, amount: 20000n, transactionId: '4088878653' });
  });
});
