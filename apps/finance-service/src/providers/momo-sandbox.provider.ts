import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MomoWebhookInput } from '../inputs/payment.input';

export type MomoCreateCommand = Readonly<{
  amount: bigint;
  orderId: string;
  requestId: string;
  orderInfo: string;
}>;
export type MomoCreateResult = Readonly<{
  resultCode: number;
  message: string;
  paymentUrl?: string;
  transactionId?: string;
  responseTime: string;
}>;
export type MomoQueryResult = Readonly<{
  resultCode: number;
  message: string;
  amount?: bigint;
  orderId: string;
  transactionId?: string;
  responseTime: string;
}>;
type Fetch = typeof fetch;

const hmac = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value, 'utf8').digest('hex');
export const momoCreateRawSignature = (value: {
  accessKey: string;
  amount: string;
  extraData: string;
  ipnUrl: string;
  orderId: string;
  orderInfo: string;
  partnerCode: string;
  redirectUrl: string;
  requestId: string;
  requestType: string;
}) =>
  `accessKey=${value.accessKey}&amount=${value.amount}&extraData=${value.extraData}` +
  `&ipnUrl=${value.ipnUrl}&orderId=${value.orderId}&orderInfo=${value.orderInfo}` +
  `&partnerCode=${value.partnerCode}&redirectUrl=${value.redirectUrl}` +
  `&requestId=${value.requestId}&requestType=${value.requestType}`;
export const momoQueryRawSignature = (value: {
  accessKey: string;
  orderId: string;
  partnerCode: string;
  requestId: string;
}) =>
  `accessKey=${value.accessKey}&orderId=${value.orderId}&partnerCode=${value.partnerCode}&requestId=${value.requestId}`;
export const momoIpnRawSignature = (value: MomoWebhookInput) =>
  `accessKey=$ACCESS_KEY&amount=${value.amount}&extraData=${value.extraData}` +
  `&message=${value.message}&orderId=${value.orderId}&orderInfo=${value.orderInfo}` +
  `&orderType=${value.orderType}&partnerCode=${value.partnerCode}&payType=${value.payType}` +
  `&requestId=${value.requestId}&responseTime=${value.responseTime}` +
  `&resultCode=${value.resultCode}&transId=${value.transactionId}`;

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MOMO_RESPONSE');
  return value as Record<string, unknown>;
};
const integer = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2_147_483_647)
    throw new Error('MOMO_RESPONSE');
  return Number(value);
};
const string = (value: unknown, max = 255) => {
  if (typeof value !== 'string' || !value || value.includes('\u0000') || value.length > max)
    throw new Error('MOMO_RESPONSE');
  return value;
};
const integerString = (value: unknown, max = 20) => {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== 'string' || !/^\d+$/.test(result) || result.length > max)
    throw new Error('MOMO_RESPONSE');
  return result;
};

@Injectable()
export class MomoSandboxProvider {
  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject('MOMO_FETCH') private readonly fetcher: Fetch = fetch,
  ) {}
  private value(name: string) {
    return this.config.get<string>(name) ?? '';
  }
  mode() {
    const mode = this.value('MOMO_SANDBOX_MODE') || 'disabled';
    if (!['disabled', 'mock', 'remote'].includes(mode)) throw new Error('Invalid MoMo mode');
    if (mode === 'mock' && this.value('NODE_ENV') !== 'test') throw new Error('Unsafe MoMo mock');
    return mode as 'disabled' | 'mock' | 'remote';
  }
  partnerCode() {
    return this.mode() === 'mock'
      ? this.value('MOMO_PARTNER_CODE') || 'MOMO_TEST'
      : this.value('MOMO_PARTNER_CODE');
  }
  ready() {
    const mode = this.mode();
    if (mode === 'disabled') return false;
    if (mode === 'mock') return true;
    return Boolean(
      this.partnerCode() &&
      this.value('MOMO_ACCESS_KEY') &&
      this.value('MOMO_SECRET_KEY') &&
      this.urls(),
    );
  }
  private urls() {
    const create = this.value('MOMO_CREATE_URL');
    const query = this.value('MOMO_QUERY_URL');
    const redirect = this.value('MOMO_REDIRECT_URL');
    const ipn = this.value('MOMO_IPN_URL');
    if (
      create !== 'https://test-payment.momo.vn/v2/gateway/api/create' ||
      query !== 'https://test-payment.momo.vn/v2/gateway/api/query' ||
      !/^https:\/\/[^\s]+$/.test(redirect) ||
      !/^https:\/\/[^\s]+$/.test(ipn)
    )
      throw new Error('Invalid MoMo URLs');
    return { create, query, redirect, ipn };
  }
  private credentials() {
    const partnerCode = this.partnerCode(),
      accessKey = this.value('MOMO_ACCESS_KEY'),
      secretKey = this.value('MOMO_SECRET_KEY');
    if (
      !partnerCode ||
      partnerCode.length > 100 ||
      (this.mode() !== 'mock' && (!accessKey || !secretKey))
    )
      throw new Error('MoMo is unavailable');
    return { partnerCode, accessKey, secretKey };
  }
  verifyIpn(input: MomoWebhookInput) {
    if (this.mode() === 'disabled') return false;
    const { accessKey, secretKey } = this.credentials();
    const expected = Buffer.from(
      hmac(secretKey, momoIpnRawSignature(input).replace('$ACCESS_KEY', accessKey)),
      'hex',
    );
    const provided = Buffer.from(input.signature, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
  async create(input: MomoCreateCommand): Promise<MomoCreateResult> {
    const mode = this.mode();
    if (mode === 'disabled') throw new Error('MoMo is unavailable');
    if (mode === 'mock')
      return {
        resultCode: 0,
        message: 'Mock payment link created',
        paymentUrl: `https://test-payment.momo.vn/mock/${encodeURIComponent(input.orderId)}`,
        responseTime: String(Date.now()),
      };
    const urls = this.urls();
    const credentials = this.credentials();
    const values = {
      accessKey: credentials.accessKey,
      amount: input.amount.toString(),
      extraData: '',
      ipnUrl: urls.ipn,
      orderId: input.orderId,
      orderInfo: input.orderInfo,
      partnerCode: credentials.partnerCode,
      redirectUrl: urls.redirect,
      requestId: input.requestId,
      requestType: 'captureWallet',
    };
    const response = await this.fetcher(urls.create, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        partnerCode: values.partnerCode,
        requestId: values.requestId,
        amount: Number(values.amount),
        orderId: values.orderId,
        orderInfo: values.orderInfo,
        redirectUrl: values.redirectUrl,
        ipnUrl: values.ipnUrl,
        requestType: values.requestType,
        extraData: values.extraData,
        lang: 'vi',
        autoCapture: true,
        signature: hmac(credentials.secretKey, momoCreateRawSignature(values)),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`MOMO_HTTP_${response.status}`);
    const data = object(await response.json());
    const resultCode = integer(data.resultCode);
    const orderId = string(data.orderId, 100);
    const requestId = string(data.requestId, 100);
    if (orderId !== input.orderId || requestId !== input.requestId)
      throw new Error('MOMO_RESPONSE_MISMATCH');
    const paymentUrl = data.payUrl === undefined ? undefined : string(data.payUrl, 2048);
    if (paymentUrl && !/^https:\/\/test-payment\.momo\.vn(?:\/|$)/.test(paymentUrl))
      throw new Error('MOMO_RESPONSE_URL');
    return {
      resultCode,
      message: string(data.message, 255),
      paymentUrl,
      responseTime: integerString(data.responseTime),
    };
  }
  async query(input: Pick<MomoCreateCommand, 'orderId' | 'requestId'>): Promise<MomoQueryResult> {
    const mode = this.mode();
    if (mode === 'disabled') throw new Error('MoMo is unavailable');
    if (mode === 'mock')
      return {
        resultCode: 1000,
        message: 'Mock transaction is pending',
        orderId: input.orderId,
        responseTime: String(Date.now()),
      };
    const urls = this.urls();
    const credentials = this.credentials();
    const values = {
      accessKey: credentials.accessKey,
      orderId: input.orderId,
      partnerCode: credentials.partnerCode,
      requestId: input.requestId,
    };
    const response = await this.fetcher(urls.query, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        partnerCode: values.partnerCode,
        requestId: values.requestId,
        orderId: values.orderId,
        lang: 'vi',
        signature: hmac(credentials.secretKey, momoQueryRawSignature(values)),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`MOMO_HTTP_${response.status}`);
    const data = object(await response.json());
    const orderId = string(data.orderId, 100);
    if (orderId !== input.orderId) throw new Error('MOMO_RESPONSE_MISMATCH');
    const amountRaw = data.amount;
    const transaction = data.transId === undefined ? undefined : integerString(data.transId, 40);
    return {
      resultCode: integer(data.resultCode),
      message: string(data.message, 255),
      amount: amountRaw === undefined ? undefined : BigInt(integerString(amountRaw, 19)),
      orderId,
      transactionId: transaction,
      responseTime: integerString(data.responseTime),
    };
  }
}
