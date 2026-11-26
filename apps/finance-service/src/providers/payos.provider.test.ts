import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import {
  normalizedAccountName,
  PayosError,
  PayosProvider,
  payosCreateSignature,
  payosDataSignature,
  payosQueryString,
} from './payos.provider';

/** Sample from payos.vn/docs/tich-hop-webhook/kiem-tra-du-lieu-voi-signature/ (verified by hand). */
const DOCS_KEY = '1a54716c8f0efb2744fb28b6e38b25da7f67a925d98bc1c18bd8faaecadd7675';
const DOCS_DATA = {
  orderCode: 123,
  amount: 3000,
  description: 'VQRIO123',
  accountNumber: '12345678',
  reference: 'TF230204212323',
  transactionDateTime: '2023-02-04 18:25:00',
  currency: 'VND',
  paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
  code: '00',
  desc: 'Thành công',
  counterAccountBankId: '',
  counterAccountBankName: '',
  counterAccountName: '',
  counterAccountNumber: '',
  virtualAccountName: '',
  virtualAccountNumber: '',
};
const DOCS_SIGNATURE = '412e915d2871504ed31be63c8f62a149a4410d34c4c42affc9006ef9917eaa03';

const env = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;
const live = {
  PAYOS_MODE: 'live',
  PAYOS_CLIENT_ID: 'client-id-0001',
  PAYOS_API_KEY: 'api-key-00000001',
  PAYOS_CHECKSUM_KEY: DOCS_KEY,
  PAYOS_BANK_CODE: 'MB',
  PAYOS_ACCOUNT_NUMBER: '0123 456 789',
};
const signed = (data: Record<string, unknown>, key = DOCS_KEY) => ({
  code: '00',
  desc: 'success',
  data,
  signature: payosDataSignature(data, key),
});
const respond = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('payOS signatures follow the official SDK', () => {
  it('reproduces the documented webhook signature', () => {
    expect(payosDataSignature(DOCS_DATA, DOCS_KEY)).toBe(DOCS_SIGNATURE);
  });
  it('sorts keys, blanks null values, drops undefined and stringifies arrays', () => {
    expect(payosQueryString({ b: null, a: 'x', c: undefined, d: 'null', e: [{ z: 1, y: 2 }] })).toBe(
      'a=x&b=&d=&e=[{"y":2,"z":1}]',
    );
  });
  it('signs exactly the five create-link fields in alphabetical order', () => {
    const value = {
      amount: 2000,
      cancelUrl: 'https://x/c',
      description: 'WF1',
      orderCode: 7,
      returnUrl: 'https://x/r',
    };
    expect(payosCreateSignature(value, 'k')).toBe(
      payosDataSignature(
        {
          amount: 2000,
          cancelUrl: 'https://x/c',
          description: 'WF1',
          orderCode: 7,
          returnUrl: 'https://x/r',
        },
        'k',
      ),
    );
  });
});

describe('PayosProvider', () => {
  it('is ready only with credentials and a valid linked account, never mock outside tests', () => {
    expect(new PayosProvider(env(live)).ready()).toBe(true);
    expect(new PayosProvider(env({ ...live, PAYOS_API_KEY: '' })).ready()).toBe(false);
    expect(new PayosProvider(env({ ...live, PAYOS_BANK_CODE: 'NOPE' })).ready()).toBe(false);
    expect(new PayosProvider(env({ ...live, PAYOS_MODE: 'disabled' })).ready()).toBe(false);
    expect(() => new PayosProvider(env({ ...live, PAYOS_MODE: 'mock' })).ready()).toThrow();
    expect(
      new PayosProvider(env({ ...live, PAYOS_MODE: 'mock', NODE_ENV: 'test' })).ready(),
    ).toBe(true);
    expect(() => new PayosProvider(env({ ...live, PAYOS_MODE: 'yes' })).mode()).toThrow();
  });

  it('accepts only the VietQR destination that is exactly the payOS account', () => {
    const payos = new PayosProvider(env(live));
    const snapshot = (bank: string, account: string, type = 'VIETQR') => ({
      destination_type: type,
      recipient: { bank_code: bank, account_number: account, account_name: 'A' },
    });
    expect(payos.acceptsDestination(snapshot('MB', '0123456789'))).toBe(true);
    expect(payos.acceptsDestination(snapshot('mb', '0123 456789'))).toBe(true);
    expect(payos.acceptsDestination(snapshot('VCB', '0123456789'))).toBe(false);
    expect(payos.acceptsDestination(snapshot('MB', '0123456780'))).toBe(false);
    expect(payos.acceptsDestination(snapshot('MB', '0123456789', 'MOMO_SANDBOX'))).toBe(false);
    expect(payos.paysIntoAccount({ bin: '970422', accountNumber: '0123456789' }, 'A')).toBe(true);
    expect(payos.paysIntoAccount({ bin: '970436', accountNumber: '0123456789' }, 'A')).toBe(false);
    expect(payos.paysIntoAccount({ bin: '970422' }, 'A')).toBe(false);
  });

  it('accepts a payOS virtual account of the same bank only for the destination holder', () => {
    const payos = new PayosProvider(env(live));
    // ACB and other banks answer with a payOS virtual account that forwards to the linked one.
    const va = { bin: '970422', accountNumber: 'LOCCASS000123511', accountName: 'NGUYEN VAN A' };
    expect(payos.paysIntoAccount(va, 'Nguyễn  Văn A')).toBe(true);
    expect(payos.paysIntoAccount(va, 'NGUYEN VAN A ')).toBe(true);
    expect(payos.paysIntoAccount({ ...va, accountName: 'ĐỖ VĂN B' }, 'Do Van B')).toBe(true);
    expect(payos.paysIntoAccount(va, 'NGUYEN VAN B')).toBe(false);
    expect(payos.paysIntoAccount(va, '')).toBe(false);
    expect(payos.paysIntoAccount({ ...va, accountName: '' }, '')).toBe(false);
    expect(payos.paysIntoAccount({ ...va, accountName: undefined }, 'NGUYEN VAN A')).toBe(false);
    expect(payos.paysIntoAccount({ ...va, bin: '970436' }, 'NGUYEN VAN A')).toBe(false);
    expect(normalizedAccountName(' Đặng  thị Ánh ')).toBe('DANG THI ANH');
  });

  it('verifies webhooks over data and refuses tampering without throwing', () => {
    const payos = new PayosProvider(env(live));
    const body = JSON.stringify({ code: '00', desc: 'success', success: true, data: DOCS_DATA, signature: DOCS_SIGNATURE });
    const ok = payos.verifyWebhook(body);
    expect(ok.valid).toBe(true);
    if (ok.valid) {
      expect(ok.data.amount).toBe(3000n);
      expect(ok.data).not.toHaveProperty('counterAccountName');
      expect(ok.data.virtualAccountNumber).toBe(undefined);
    }
    const viaVa = { ...DOCS_DATA, virtualAccountNumber: 'LOCCASS000123511' };
    const va = payos.verifyWebhook(
      JSON.stringify({ data: viaVa, signature: payosDataSignature(viaVa, DOCS_KEY) }),
    );
    expect(va.valid && va.data.virtualAccountNumber).toBe('LOCCASS000123511');
    const tampered = JSON.stringify({ data: { ...DOCS_DATA, amount: 30000 }, signature: DOCS_SIGNATURE });
    expect(payos.verifyWebhook(tampered).valid).toBe(false);
    expect(payos.verifyWebhook('{').valid).toBe(false);
    expect(payos.verifyWebhook(JSON.stringify({ data: DOCS_DATA })).valid).toBe(false);
    const withEquals = { ...DOCS_DATA, desc: 'a=b' };
    expect(
      payos.verifyWebhook(JSON.stringify({ data: withEquals, signature: payosDataSignature(withEquals, DOCS_KEY) }))
        .valid,
    ).toBe(false);
    expect(new PayosProvider(env({ ...live, PAYOS_MODE: 'disabled' })).verifyWebhook(body).valid).toBe(
      false,
    );
  });

  it('creates a signed link and trusts only a signed answer from pay.payos.vn', async () => {
    const answer = {
      bin: '970422',
      accountNumber: '0123456789',
      accountName: 'NGUYEN VAN A',
      amount: 150000,
      description: 'WFABC',
      orderCode: 123456789012,
      currency: 'VND',
      paymentLinkId: 'abc123',
      status: 'PENDING',
      checkoutUrl: 'https://pay.payos.vn/web/abc123',
      qrCode: '000201',
    };
    const fetcher = vi.fn().mockResolvedValue(respond(200, signed(answer)));
    const payos = new PayosProvider(env(live), fetcher);
    const command = {
      orderCode: 123456789012,
      amount: 150000n,
      description: 'WFABC',
      returnUrl: 'https://gw/api/v1/payments/payos/return/x',
      cancelUrl: 'https://gw/api/v1/payments/payos/return/x',
      expiredAt: 1_800_000_000,
    };
    const link = await payos.create(command);
    expect(link).toMatchObject({ status: 'PENDING', paymentLinkId: 'abc123', bin: '970422' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api-merchant.payos.vn/v2/payment-requests');
    expect(init.headers).toMatchObject({ 'x-client-id': 'client-id-0001', 'x-api-key': 'api-key-00000001' });
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ orderCode: 123456789012, amount: 150000, expiredAt: 1_800_000_000 });
    expect(sent.signature).toBe(
      payosCreateSignature({ ...command, amount: 150000 }, DOCS_KEY),
    );

    fetcher.mockResolvedValueOnce(respond(200, { ...signed(answer), signature: 'f'.repeat(64) }));
    await expect(payos.create(command)).rejects.toMatchObject({ kind: 'uncertain' });
    fetcher.mockResolvedValueOnce(
      respond(200, signed({ ...answer, checkoutUrl: 'https://evil.example/pay' })),
    );
    await expect(payos.create(command)).rejects.toMatchObject({ code: 'PAYOS_RESPONSE_URL' });
    fetcher.mockResolvedValueOnce(respond(200, signed({ ...answer, amount: 1 })));
    await expect(payos.create(command)).rejects.toMatchObject({ code: 'PAYOS_RESPONSE_MISMATCH' });
  });

  it('separates refusals from outages so no paid link is ever marked failed', async () => {
    const fetcher = vi.fn();
    const payos = new PayosProvider(env(live), fetcher);
    const command = {
      orderCode: 1,
      amount: 2000n,
      description: 'WF1',
      returnUrl: 'https://gw/r',
      cancelUrl: 'https://gw/r',
      expiredAt: 1,
    };
    fetcher.mockResolvedValueOnce(respond(200, { code: '231', desc: 'Đơn thanh toán đã tồn tại', data: null }));
    await expect(payos.create(command)).rejects.toEqual(new PayosError('PAYOS_231', 'definitive'));
    fetcher.mockResolvedValueOnce(respond(401, { code: '401', desc: 'Unauthorized' }));
    await expect(payos.create(command)).rejects.toMatchObject({ kind: 'definitive' });
    fetcher.mockResolvedValueOnce(respond(502, 'bad gateway'));
    await expect(payos.create(command)).rejects.toMatchObject({ kind: 'uncertain' });
    fetcher.mockResolvedValueOnce(respond(429, {}));
    await expect(payos.create(command)).rejects.toMatchObject({ kind: 'uncertain' });
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(payos.create(command)).rejects.toEqual(new PayosError('PAYOS_NETWORK', 'uncertain'));
  });

  it('reads a link with its latest bank reference', async () => {
    const data = {
      id: 'abc123',
      orderCode: 55,
      amount: 2000,
      amountPaid: 2000,
      amountRemaining: 0,
      status: 'PAID',
      createdAt: '2026-11-26T01:00:00+07:00',
      transactions: [
        { reference: 'FT2611261234', amount: 2000, accountNumber: '0123456789', description: 'WF1' },
      ],
      canceledAt: null,
      cancellationReason: null,
    };
    const fetcher = vi.fn().mockResolvedValue(respond(200, signed(data)));
    const link = await new PayosProvider(env(live), fetcher).get(55, 2000n);
    expect(fetcher.mock.calls[0]![0]).toBe('https://api-merchant.payos.vn/v2/payment-requests/55');
    expect(link).toMatchObject({ status: 'PAID', reference: 'FT2611261234', amountPaid: 2000n });
  });
});
