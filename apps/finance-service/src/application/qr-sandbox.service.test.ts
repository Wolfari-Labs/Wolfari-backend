import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { QrSandboxService } from './qr-sandbox.service';
import type { FundQueryService } from './fund-query.service';
import type { MomoSandboxProvider } from '../providers/momo-sandbox.provider';

const id = '10000000-0000-4000-8000-000000000001';
const input = {
  actor_user_id: id,
  trip_id: id,
  request_id: id,
  amount: '150000',
  note: 'Thanh toan bua toi',
};
function setup(environment = 'test') {
  const access = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn().mockResolvedValue({
    resultCode: 0,
    paymentUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=fixture',
  });
  const ready = vi.fn().mockReturnValue(true);
  const service = new QrSandboxService(
    { authorizeQrSandbox: access } as unknown as FundQueryService,
    { create, ready } as unknown as MomoSandboxProvider,
    new ConfigService({ NODE_ENV: environment }),
  );
  return { service, access, create, ready };
}
describe('isolated QR MoMo Sandbox checkout', () => {
  it('authorizes the trip and sends the entered amount/note to MoMo with stable scoped order IDs', async () => {
    const { service, access, create } = setup();
    const [first, second] = await Promise.all([
      service.create(input, id, Date.now() + 35000),
      service.create(input, id, Date.now() + 35000),
    ]);
    expect(access).toHaveBeenCalledWith(id, id, id, expect.any(Number));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      amount: 150000n,
      orderId: first.order_id,
      requestId: id,
      orderInfo: 'Wolfari QR Sandbox: Thanh toan bua toi',
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ amount: '150000', environment: 'SANDBOX', request_id: id });
    expect(first.order_id).toMatch(/^wqr-[a-f0-9]{40}$/);
    await expect(
      service.create({ ...input, amount: '160000' }, id, Date.now() + 35000),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('never calls MoMo on denied access, invalid values, unavailable configuration or production', async () => {
    const f = setup();
    f.access.mockRejectedValueOnce(new Error('Denied'));
    await expect(f.service.create(input, id, Date.now() + 35000)).rejects.toThrow('Denied');
    expect(f.create).not.toHaveBeenCalled();
    for (const change of [
      { amount: '999' },
      { amount: '50000001' },
      { note: '\nInjected' },
      { request_id: 'bad' },
    ])
      await expect(
        f.service.create({ ...input, ...change }, id, Date.now() + 35000),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const production = setup('production');
    await expect(production.service.create(input, id, Date.now() + 35000)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(production.create).not.toHaveBeenCalled();
    f.ready.mockReturnValue(false);
    await expect(f.service.create(input, id, Date.now() + 35000)).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('sanitizes invalid configuration without contacting the provider', async () => {
    const f = setup();
    f.ready.mockImplementation(() => { throw new Error('private configuration diagnostic'); });
    await expect(f.service.create(input, id, Date.now() + 35000)).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_NOT_CONFIGURED', message: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('denies cached checkout replay after authorization is revoked', async () => {
    const f = setup();
    await f.service.create(input, id, Date.now() + 35000);
    f.access.mockRejectedValueOnce(
      Object.assign(new Error('Denied'), { code: 'PERMISSION_DENIED' }),
    );
    await expect(f.service.create(input, id, Date.now() + 35000)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('rejects live/unsafe provider URLs and retries a failed call with the same order and request', async () => {
    const f = setup();
    f.create.mockResolvedValueOnce({ resultCode: 0, paymentUrl: 'https://payment.momo.vn/pay' });
    await expect(f.service.create(input, id, Date.now() + 35000)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await f.service.create(input, id, Date.now() + 35000);
    expect(f.create.mock.calls[0]).toEqual(f.create.mock.calls[1]);
  });
});
