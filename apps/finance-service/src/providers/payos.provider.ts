import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { findVietQrBank, isPayosReturnUrl } from '@wolfari/common';

/**
 * payOS (Casso) VietQR payment links for real contributions. The money is a bank transfer that
 * settles straight into the account linked to the payOS payment channel; Wolfari never holds it.
 * Signatures follow the official SDK (github.com/payOSHQ/payos-lib-node, src/crypto and
 * src/utils): HMAC-SHA256 with the channel checksum key over sorted `key=value` pairs.
 */
export const PAYOS_API_URL = 'https://api-merchant.payos.vn';
export const PAYOS_CHECKOUT_HOST = 'pay.payos.vn';
/** Payment link lifetime; payOS takes `expiredAt` as a Unix timestamp in seconds (Int32). */
export const PAYOS_LINK_MINUTES = 15;

export type PayosLinkStatus =
  | 'PENDING'
  | 'CANCELLED'
  | 'UNDERPAID'
  | 'PAID'
  | 'EXPIRED'
  | 'PROCESSING'
  | 'FAILED';
const STATUSES = new Set<PayosLinkStatus>([
  'PENDING',
  'CANCELLED',
  'UNDERPAID',
  'PAID',
  'EXPIRED',
  'PROCESSING',
  'FAILED',
]);

export type PayosCreateCommand = Readonly<{
  orderCode: number;
  amount: bigint;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  expiredAt: number;
}>;
export type PayosLink = Readonly<{
  orderCode: number;
  amount: bigint;
  status: PayosLinkStatus;
  paymentLinkId: string;
  checkoutUrl?: string;
  bin?: string;
  /** The linked account, or a payOS virtual account of the same bank (ACB, …). */
  accountNumber?: string;
  accountName?: string;
  amountPaid?: bigint;
  /** Bank reference of the latest transaction into the link, when payOS reports one. */
  reference?: string;
}>;
export type PayosWebhookData = Readonly<{
  orderCode: number;
  amount: bigint;
  description: string;
  accountNumber: string;
  /** Set when the payment went through a payOS virtual account. */
  virtualAccountNumber?: string;
  reference: string;
  transactionDateTime: string;
  currency: string;
  paymentLinkId: string;
  code: string;
  desc: string;
}>;

/** `definitive`: payOS answered and refused; `uncertain`: no trustworthy answer (network, 5xx). */
export class PayosError extends Error {
  constructor(
    public readonly code: string,
    public readonly kind: 'definitive' | 'uncertain',
  ) {
    super(code);
    this.name = 'PayosError';
  }
}

type Fetch = typeof fetch;
type Data = Record<string, unknown>;

const sortKeys = (value: Data): Data =>
  Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
const plainObject = (value: unknown): value is Data =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** SDK `convertObjToQueryStr(sortObjDataByKey(data))`, byte for byte. */
export function payosQueryString(data: Data): string {
  const sorted = sortKeys(data);
  return Object.keys(sorted)
    .filter((key) => sorted[key] !== undefined)
    .map((key) => {
      let value: unknown = sorted[key];
      if (value && Array.isArray(value))
        value = JSON.stringify(value.map((item) => (plainObject(item) ? sortKeys(item) : item)));
      if (value === null || value === undefined || value === 'undefined' || value === 'null')
        value = '';
      return `${key}=${String(value)}`;
    })
    .join('&');
}
export const payosDataSignature = (data: Data, checksumKey: string) =>
  createHmac('sha256', checksumKey).update(payosQueryString(data), 'utf8').digest('hex');
/** SDK `createSignatureOfPaymentRequest`: exactly these five fields in this order. */
export const payosCreateSignature = (
  value: Readonly<{
    amount: number | string;
    cancelUrl: string;
    description: string;
    orderCode: number;
    returnUrl: string;
  }>,
  checksumKey: string,
) =>
  createHmac('sha256', checksumKey)
    .update(
      `amount=${value.amount}&cancelUrl=${value.cancelUrl}&description=${value.description}` +
        `&orderCode=${value.orderCode}&returnUrl=${value.returnUrl}`,
      'utf8',
    )
    .digest('hex');

const sameHex = (left: string, right: string) => {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
};
const text = (value: unknown, max: number, code: string) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw new PayosError(code, 'uncertain');
  return value;
};
const integer = (value: unknown, code: string) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new PayosError(code, 'uncertain');
  return Number(value);
};
export const normalizedAccount = (value: string) => value.replace(/\s+/g, '').toUpperCase();
/** Account holder names compare without diacritics, case or extra spaces (banks print ASCII capitals). */
export const normalizedAccountName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'D')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

/** Mirrors the SDK `validateWebhookData` before any signature is computed. */
function webhookData(value: unknown): PayosWebhookData & { raw: Data } {
  if (!plainObject(value)) throw new PayosError('PAYOS_WEBHOOK_DATA', 'definitive');
  for (const [key, field] of Object.entries(value)) {
    if (!key || key === '__proto__' || /[^A-Za-z0-9_]/.test(key))
      throw new PayosError('PAYOS_WEBHOOK_DATA', 'definitive');
    if (typeof field === 'string' && field.includes('='))
      throw new PayosError('PAYOS_WEBHOOK_DATA', 'definitive');
    if (field !== null && typeof field !== 'string' && !Number.isSafeInteger(field))
      throw new PayosError('PAYOS_WEBHOOK_DATA', 'definitive');
  }
  const required = (key: string, max: number) => {
    const field = value[key];
    if (typeof field !== 'string' || field.length > max)
      throw new PayosError('PAYOS_WEBHOOK_DATA', 'definitive');
    return field;
  };
  if (!Number.isSafeInteger(value.orderCode) || !Number.isSafeInteger(value.amount))
    throw new PayosError('PAYOS_WEBHOOK_DATA', 'definitive');
  if (Number(value.orderCode) <= 0 || Number(value.amount) <= 0)
    throw new PayosError('PAYOS_WEBHOOK_DATA', 'definitive');
  return {
    orderCode: Number(value.orderCode),
    amount: BigInt(Number(value.amount)),
    description: required('description', 255),
    accountNumber: required('accountNumber', 40),
    virtualAccountNumber:
      typeof value.virtualAccountNumber === 'string' &&
      value.virtualAccountNumber &&
      value.virtualAccountNumber.length <= 40
        ? value.virtualAccountNumber
        : undefined,
    reference: required('reference', 100),
    transactionDateTime: required('transactionDateTime', 40),
    currency: required('currency', 8),
    paymentLinkId: required('paymentLinkId', 100),
    code: required('code', 20),
    desc: required('desc', 255),
    raw: value,
  };
}

export type PayosAccount = Readonly<{ bankCode: string; bankBin: string; accountNumber: string }>;

@Injectable()
export class PayosProvider {
  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject('PAYOS_FETCH') private readonly fetcher: Fetch = fetch,
  ) {}
  private value(name: string) {
    return this.config.get<string>(name)?.trim() ?? '';
  }
  mode(): 'disabled' | 'live' | 'mock' {
    const mode = this.value('PAYOS_MODE') || 'disabled';
    if (!['disabled', 'live', 'mock'].includes(mode)) throw new Error('Invalid PAYOS_MODE');
    if (mode === 'mock' && this.value('NODE_ENV') !== 'test') throw new Error('Unsafe payOS mock');
    return mode as 'disabled' | 'live' | 'mock';
  }
  production() {
    return this.value('NODE_ENV') === 'production';
  }
  /** Fallback return page when a client sends none (web, scripts); optional. */
  defaultReturnUrl(): string | undefined {
    const value = this.value('PAYOS_RETURN_URL');
    return value && isPayosReturnUrl(value, this.production()) ? value : undefined;
  }
  /** The bank account the payOS channel pays into, from PAYOS_BANK_CODE + PAYOS_ACCOUNT_NUMBER. */
  account(): PayosAccount | undefined {
    const bank = findVietQrBank(this.value('PAYOS_BANK_CODE'));
    const accountNumber = normalizedAccount(this.value('PAYOS_ACCOUNT_NUMBER'));
    if (!bank || !bank.transfer_supported || !/^[A-Z0-9]{1,19}$/.test(accountNumber))
      return undefined;
    return { bankCode: bank.code, bankBin: bank.bin, accountNumber };
  }
  private credentials() {
    const clientId = this.value('PAYOS_CLIENT_ID'),
      apiKey = this.value('PAYOS_API_KEY'),
      checksumKey = this.value('PAYOS_CHECKSUM_KEY');
    const token = /^[\x21-\x7e]{8,200}$/;
    if (!token.test(clientId) || !token.test(apiKey) || !token.test(checksumKey))
      throw new Error('payOS is unavailable');
    return { clientId, apiKey, checksumKey };
  }
  ready() {
    const mode = this.mode();
    if (mode === 'disabled' || !this.account()) return false;
    if (mode === 'mock') return true;
    try {
      this.credentials();
      return true;
    } catch {
      return false;
    }
  }
  /** Stored as the attempt merchant; the client ID is an identifier, not a secret. */
  merchantId() {
    return this.mode() === 'mock' ? 'PAYOS_TEST' : this.credentials().clientId;
  }
  /** True only for a VietQR destination that is exactly the payOS channel account. */
  acceptsDestination(snapshot: unknown): boolean {
    const account = this.account();
    if (!account || !plainObject(snapshot) || snapshot.destination_type !== 'VIETQR') return false;
    const recipient = snapshot.recipient;
    if (!plainObject(recipient) || typeof recipient.account_number !== 'string') return false;
    const bank = findVietQrBank(String(recipient.bank_code ?? ''));
    return (
      bank?.bin === account.bankBin &&
      normalizedAccount(recipient.account_number) === account.accountNumber
    );
  }
  /**
   * Whether a new link pays into the configured account. payOS answers with that account, or, for
   * banks it reaches through virtual accounts (ACB, …), with a virtual account of the same bank
   * that forwards to it; then the holder name payOS reports must be the destination's name.
   */
  paysIntoAccount(
    link: Pick<PayosLink, 'bin' | 'accountNumber' | 'accountName'>,
    destinationName: string | undefined,
  ) {
    const account = this.account();
    if (!account || link.bin !== account.bankBin || !link.accountNumber) return false;
    if (normalizedAccount(link.accountNumber) === account.accountNumber) return true;
    const name = normalizedAccountName(link.accountName ?? '');
    return Boolean(name) && name === normalizedAccountName(destinationName ?? '');
  }

  /** Verifies a raw webhook body; never throws for a forged or malformed body. */
  verifyWebhook(body: string): { valid: true; data: PayosWebhookData } | { valid: false } {
    if (this.mode() === 'disabled' || body.length > 64 * 1024) return { valid: false };
    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      return { valid: false };
    }
    if (!plainObject(envelope) || typeof envelope.signature !== 'string') return { valid: false };
    let data: ReturnType<typeof webhookData>;
    try {
      data = webhookData(envelope.data);
    } catch {
      return { valid: false };
    }
    const key = this.mode() === 'mock' ? this.mockChecksumKey() : this.credentials().checksumKey;
    if (!sameHex(payosDataSignature(data.raw, key), envelope.signature.toLowerCase()))
      return { valid: false };
    return {
      valid: true,
      data: {
        orderCode: data.orderCode,
        amount: data.amount,
        description: data.description,
        accountNumber: data.accountNumber,
        virtualAccountNumber: data.virtualAccountNumber,
        reference: data.reference,
        transactionDateTime: data.transactionDateTime,
        currency: data.currency,
        paymentLinkId: data.paymentLinkId,
        code: data.code,
        desc: data.desc,
      },
    };
  }
  /** Deterministic key so integration tests can sign webhooks without real credentials. */
  mockChecksumKey() {
    return this.value('PAYOS_CHECKSUM_KEY') || 'payos-test-checksum-key';
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Data): Promise<Data> {
    const { clientId, apiKey, checksumKey } = this.credentials();
    let response: Response;
    try {
      response = await this.fetcher(`${PAYOS_API_URL}${path}`, {
        method,
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PayosError('PAYOS_NETWORK', 'uncertain');
    }
    const status = response.status;
    if (status === 408 || status === 429 || status >= 500)
      throw new PayosError(`PAYOS_HTTP_${status}`, 'uncertain');
    const raw = await response.text().catch(() => '');
    if (raw.length > 256 * 1024) throw new PayosError('PAYOS_RESPONSE', 'uncertain');
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new PayosError(`PAYOS_HTTP_${status}`, status >= 400 ? 'definitive' : 'uncertain');
    }
    if (!plainObject(envelope)) throw new PayosError('PAYOS_RESPONSE', 'uncertain');
    const code = typeof envelope.code === 'string' ? envelope.code : '';
    if (!response.ok || code !== '00')
      throw new PayosError(
        `PAYOS_${/^[A-Za-z0-9]{1,10}$/.test(code) ? code : `HTTP_${status}`}`,
        'definitive',
      );
    if (!plainObject(envelope.data)) throw new PayosError('PAYOS_RESPONSE', 'uncertain');
    // The SDK checks the response signature of create/get; an unsigned answer is not trusted.
    if (
      typeof envelope.signature !== 'string' ||
      !sameHex(payosDataSignature(envelope.data, checksumKey), envelope.signature.toLowerCase())
    )
      throw new PayosError('PAYOS_RESPONSE_SIGNATURE', 'uncertain');
    return envelope.data;
  }
  private link(data: Data, expected: { orderCode: number; amount?: bigint }): PayosLink {
    const orderCode = integer(data.orderCode ?? data.order_code, 'PAYOS_RESPONSE');
    const amount = BigInt(integer(data.amount, 'PAYOS_RESPONSE'));
    if (orderCode !== expected.orderCode || (expected.amount && amount !== expected.amount))
      throw new PayosError('PAYOS_RESPONSE_MISMATCH', 'uncertain');
    const status = text(data.status, 20, 'PAYOS_RESPONSE') as PayosLinkStatus;
    if (!STATUSES.has(status)) throw new PayosError('PAYOS_RESPONSE', 'uncertain');
    const paymentLinkId = text(data.paymentLinkId ?? data.id, 100, 'PAYOS_RESPONSE');
    if (!/^[A-Za-z0-9]{1,100}$/.test(paymentLinkId))
      throw new PayosError('PAYOS_RESPONSE', 'uncertain');
    let checkoutUrl: string | undefined;
    if (data.checkoutUrl !== undefined && data.checkoutUrl !== null) {
      checkoutUrl = text(data.checkoutUrl, 2048, 'PAYOS_RESPONSE');
      let url: URL;
      try {
        url = new URL(checkoutUrl);
      } catch {
        throw new PayosError('PAYOS_RESPONSE_URL', 'uncertain');
      }
      if (url.protocol !== 'https:' || url.hostname !== PAYOS_CHECKOUT_HOST || url.username)
        throw new PayosError('PAYOS_RESPONSE_URL', 'uncertain');
    }
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    const last = transactions.filter(plainObject).at(-1);
    const reference =
      last && typeof last.reference === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(last.reference)
        ? last.reference
        : undefined;
    return {
      orderCode,
      amount,
      status,
      paymentLinkId,
      checkoutUrl,
      bin: typeof data.bin === 'string' ? data.bin : undefined,
      accountNumber:
        typeof data.accountNumber === 'string' && data.accountNumber.length <= 40
          ? data.accountNumber
          : undefined,
      accountName:
        typeof data.accountName === 'string' && data.accountName.length <= 200
          ? data.accountName
          : undefined,
      amountPaid:
        data.amountPaid === undefined
          ? undefined
          : BigInt(integer(data.amountPaid, 'PAYOS_RESPONSE')),
      reference,
    };
  }

  async create(input: PayosCreateCommand): Promise<PayosLink> {
    const mode = this.mode();
    if (mode === 'disabled') throw new PayosError('PAYOS_DISABLED', 'definitive');
    if (input.amount <= 0n || input.amount > BigInt(Number.MAX_SAFE_INTEGER))
      throw new PayosError('PAYOS_AMOUNT', 'definitive');
    if (mode === 'mock') {
      const account = this.account()!;
      return {
        orderCode: input.orderCode,
        amount: input.amount,
        status: 'PENDING',
        paymentLinkId: `mock${input.orderCode}`,
        checkoutUrl: `https://${PAYOS_CHECKOUT_HOST}/web/mock${input.orderCode}`,
        bin: account.bankBin,
        accountNumber: account.accountNumber,
      };
    }
    const { checksumKey } = this.credentials();
    const body = {
      orderCode: input.orderCode,
      amount: Number(input.amount),
      description: input.description,
      cancelUrl: input.cancelUrl,
      returnUrl: input.returnUrl,
      expiredAt: input.expiredAt,
    };
    const data = await this.call('POST', '/v2/payment-requests', {
      ...body,
      signature: payosCreateSignature(body, checksumKey),
    });
    return this.link(data, { orderCode: input.orderCode, amount: input.amount });
  }
  async get(orderCode: number, amount: bigint): Promise<PayosLink> {
    const mode = this.mode();
    if (mode === 'disabled') throw new PayosError('PAYOS_DISABLED', 'definitive');
    if (mode === 'mock')
      return { orderCode, amount, status: 'PENDING', paymentLinkId: `mock${orderCode}` };
    const data = await this.call('GET', `/v2/payment-requests/${orderCode}`);
    return this.link(data, { orderCode, amount });
  }
}
