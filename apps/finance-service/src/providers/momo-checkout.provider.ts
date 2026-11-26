import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { momoCreateRawSignature, momoQueryRawSignature } from './momo-sandbox.provider';

/**
 * MoMo test gateway (test-payment.momo.vn) for the QR checkout demo, separate from the
 * contribution MoMo integration. Without MOMO_CHECKOUT_* credentials it uses the public test
 * partner from MoMo's developer samples. Never enabled in production (the caller refuses it).
 */
export const MOMO_CHECKOUT_DEMO = Object.freeze({
  partnerCode: 'MOMO',
  accessKey: 'F8BBA842ECF85',
  secretKey: 'K951B6PE1waDMi640xX08PD3vg6EkVlz',
});
const CREATE_URL = 'https://test-payment.momo.vn/v2/gateway/api/create';
const QUERY_URL = 'https://test-payment.momo.vn/v2/gateway/api/query';
/** MoMo requires an IPN URL; results are read with the query API instead. */
const IPN_URL = 'https://momo.vn';

export type MomoCheckoutCreate = Readonly<{
  orderId: string;
  requestId: string;
  amount: bigint;
  orderInfo: string;
  redirectUrl: string;
}>;
export type MomoCheckoutCreated = Readonly<{ resultCode: number; message: string; payUrl?: string }>;
/** resultCode 0 = paid; 1000/7000/7002/9000 = waiting or processing; anything else failed. */
export type MomoCheckoutStatus = Readonly<{ resultCode: number; amount?: bigint; transactionId?: string }>;
type Fetch = typeof fetch;

const hmac = (key: string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest('hex');
const integer = (value: unknown) => {
  const result = typeof value === 'string' && /^-?\d{1,10}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(result) || Math.abs(Number(result)) > 2_147_483_647) throw new Error('MOMO_RESPONSE');
  return Number(result);
};
const text = (value: unknown, max = 255) =>
  typeof value === 'string' && !value.includes('\u0000') ? value.slice(0, max) : '';
const digits = (value: unknown, max = 40) => {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof result === 'string' && /^\d+$/.test(result) && result.length <= max ? result : undefined;
};

@Injectable()
export class MomoCheckoutProvider {
  private readonly logger = new Logger('MomoCheckout');
  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject('MOMO_CHECKOUT_FETCH') private readonly fetcher: Fetch = fetch,
  ) {}
  private value(name: string) {
    return this.config.get<string>(name) ?? '';
  }
  mode() {
    const mode = this.value('MOMO_CHECKOUT_MODE') || 'disabled';
    if (!['disabled', 'mock', 'remote'].includes(mode)) throw new Error('Invalid MoMo checkout mode');
    if (mode === 'mock' && this.value('NODE_ENV') !== 'test') throw new Error('Unsafe MoMo checkout mock');
    return mode as 'disabled' | 'mock' | 'remote';
  }
  ready() {
    if (this.mode() === 'disabled') return false;
    this.credentials();
    return true;
  }
  private credentials() {
    const partnerCode = this.value('MOMO_CHECKOUT_PARTNER_CODE'),
      accessKey = this.value('MOMO_CHECKOUT_ACCESS_KEY'),
      secretKey = this.value('MOMO_CHECKOUT_SECRET_KEY');
    if (!partnerCode && !accessKey && !secretKey) return { ...MOMO_CHECKOUT_DEMO, source: 'demo' as const };
    if (!/^[A-Za-z0-9_]{1,50}$/.test(partnerCode) || !/^[\x21-\x7e]{6,128}$/.test(accessKey) || !/^[\x21-\x7e]{8,128}$/.test(secretKey))
      throw new Error('Invalid MoMo checkout credentials');
    return { partnerCode, accessKey, secretKey, source: 'env' as const };
  }
  private async post(url: string, body: Record<string, unknown>) {
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data: unknown = await response.json().catch(() => undefined);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`MOMO_HTTP_${response.status}`);
    return data as Record<string, unknown>;
  }
  async create(input: MomoCheckoutCreate): Promise<MomoCheckoutCreated> {
    const mode = this.mode();
    if (mode === 'disabled') throw new Error('MoMo checkout is unavailable');
    if (mode === 'mock')
      return { resultCode: 0, message: 'Mock', payUrl: `https://test-payment.momo.vn/v2/gateway/pay?t=${encodeURIComponent(input.orderId)}` };
    const { partnerCode, accessKey, secretKey, source } = this.credentials();
    const values = {
      accessKey,
      amount: input.amount.toString(),
      extraData: '',
      ipnUrl: IPN_URL,
      orderId: input.orderId,
      orderInfo: input.orderInfo,
      partnerCode,
      redirectUrl: input.redirectUrl,
      requestId: input.requestId,
      requestType: 'payWithMethod',
    };
    const raw = momoCreateRawSignature(values);
    const data = await this.post(CREATE_URL, {
      partnerCode,
      partnerName: 'Wolfari Sandbox',
      storeId: 'WolfariSandbox',
      requestId: values.requestId,
      amount: Number(values.amount),
      orderId: values.orderId,
      orderInfo: values.orderInfo,
      redirectUrl: values.redirectUrl,
      ipnUrl: values.ipnUrl,
      requestType: values.requestType,
      extraData: values.extraData,
      autoCapture: true,
      lang: 'vi',
      signature: hmac(secretKey, raw),
    });
    const resultCode = integer(data.resultCode);
    const payUrl = typeof data.payUrl === 'string' && data.payUrl ? data.payUrl : undefined;
    if (payUrl) {
      const url = new URL(payUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'test-payment.momo.vn' || url.username || url.password || url.port)
        throw new Error('MOMO_RESPONSE_URL');
    }
    if (resultCode !== 0)
      // Signed fields only (no keys) so a rejected request can be checked by hand.
      this.logger.warn(`MOMO_CHECKOUT_INPUT credentials=${source} raw=${JSON.stringify(raw.replace(accessKey, '<accessKey>'))}`);
    return { resultCode, message: text(data.message), payUrl };
  }
  async query(orderId: string, requestId: string): Promise<MomoCheckoutStatus> {
    const mode = this.mode();
    if (mode === 'disabled') throw new Error('MoMo checkout is unavailable');
    if (mode === 'mock') return { resultCode: 1000 };
    const { partnerCode, accessKey, secretKey } = this.credentials();
    const data = await this.post(QUERY_URL, {
      partnerCode,
      requestId,
      orderId,
      lang: 'vi',
      signature: hmac(secretKey, momoQueryRawSignature({ accessKey, orderId, partnerCode, requestId })),
    });
    const amount = digits(data.amount, 19);
    return {
      resultCode: integer(data.resultCode),
      amount: amount === undefined ? undefined : BigInt(amount),
      transactionId: digits(data.transId),
    };
  }
}
