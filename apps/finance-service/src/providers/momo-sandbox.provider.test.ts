import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import {
  MomoSandboxProvider,
  momoCreateRawSignature,
  momoIpnRawSignature,
} from './momo-sandbox.provider';
import type { MomoWebhookInput } from '../inputs/payment.input';

const webhook: MomoWebhookInput = {
  partnerCode: 'MOMO_TEST',
  orderId: 'WLF-order',
  requestId: 'request-1',
  amount: 1000n,
  orderInfo: 'Contribution',
  orderType: 'momo_wallet',
  transactionId: '123456',
  resultCode: 0,
  message: 'Successful.',
  payType: 'qr',
  responseTime: '1792627200000',
  extraData: '',
  signature: '',
};
describe('MoMo Sandbox provider', () => {
  it('builds signatures in provider order and verifies IPN timing-safely', () => {
    expect(
      momoCreateRawSignature({
        accessKey: 'access',
        amount: '1000',
        extraData: '',
        ipnUrl: 'https://example.test/ipn',
        orderId: 'order',
        orderInfo: 'info',
        partnerCode: 'partner',
        redirectUrl: 'https://example.test/result',
        requestId: 'request',
        requestType: 'captureWallet',
      }),
    ).toBe(
      'accessKey=access&amount=1000&extraData=&ipnUrl=https://example.test/ipn&orderId=order&orderInfo=info&partnerCode=partner&redirectUrl=https://example.test/result&requestId=request&requestType=captureWallet',
    );
    const provider = new MomoSandboxProvider(
      new ConfigService({
        NODE_ENV: 'test',
        MOMO_SANDBOX_MODE: 'mock',
        MOMO_PARTNER_CODE: 'MOMO_TEST',
        MOMO_ACCESS_KEY: 'access',
        MOMO_SECRET_KEY: 'secret',
      }),
    );
    const signature = createHmac('sha256', 'secret')
      .update(momoIpnRawSignature(webhook).replace('$ACCESS_KEY', 'access'))
      .digest('hex');
    expect(provider.verifyIpn({ ...webhook, signature })).toBe(true);
    expect(provider.verifyIpn({ ...webhook, signature: '0'.repeat(64) })).toBe(false);
  });
  it('uses deterministic local links only in test mode', async () => {
    const provider = new MomoSandboxProvider(
      new ConfigService({ NODE_ENV: 'test', MOMO_SANDBOX_MODE: 'mock' }),
    );
    await expect(
      provider.create({ amount: 1000n, orderId: 'order', requestId: 'request', orderInfo: 'info' }),
    ).resolves.toMatchObject({
      resultCode: 0,
      paymentUrl: 'https://test-payment.momo.vn/mock/order',
    });
    expect(() =>
      new MomoSandboxProvider(
        new ConfigService({ NODE_ENV: 'development', MOMO_SANDBOX_MODE: 'mock' }),
      ).ready(),
    ).toThrow('Unsafe MoMo mock');
  });
});
