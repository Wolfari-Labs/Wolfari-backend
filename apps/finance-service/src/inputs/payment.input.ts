import { parsePositiveVndAmount } from '../domain/money';

export class PaymentInputError extends TypeError {}

const INT32_MAX = 2_147_483_647;
const text = (value: unknown, max: number, label: string) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\u0000') ||
    [...value.trim()].length > max
  )
    throw new PaymentInputError(`Invalid ${label}`);
  return value.trim();
};
const version = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > INT32_MAX)
    throw new PaymentInputError('Invalid version');
  return Number(value);
};

export type CreatePaymentAttemptInput = Readonly<{
  provider: 'MOMO_SANDBOX';
  expectedVersion: number;
  expectedFinanceVersion: number;
}>;
export function parseCreatePaymentAttemptInput(value: Record<string, unknown>) {
  if (value.provider !== 'MOMO_SANDBOX') throw new PaymentInputError('Invalid provider');
  return {
    provider: 'MOMO_SANDBOX' as const,
    expectedVersion: version(value.expected_version),
    expectedFinanceVersion: version(value.expected_finance_version),
  };
}

export type ReconcilePaymentAttemptInput = Readonly<{ reason: string }>;
export function parseReconcilePaymentAttemptInput(value: Record<string, unknown>) {
  return { reason: text(value.reason, 1024, 'reason') };
}

export type ResolvePaymentExceptionInput = Readonly<{
  resolution: 'LINKED' | 'NO_FINANCIAL_EFFECT';
  linkedAttemptId?: string;
  reason: string;
  expectedFinanceVersion: number;
}>;
export function parseResolvePaymentExceptionInput(
  value: Record<string, unknown>,
): ResolvePaymentExceptionInput {
  if (value.resolution !== 'LINKED' && value.resolution !== 'NO_FINANCIAL_EFFECT')
    throw new PaymentInputError('Invalid resolution');
  const linked = value.linked_attempt_id;
  if (value.resolution === 'LINKED' ? typeof linked !== 'string' : linked !== undefined)
    throw new PaymentInputError('Invalid linked attempt');
  return {
    resolution: value.resolution,
    ...(typeof linked === 'string' ? { linkedAttemptId: linked } : {}),
    reason: text(value.reason, 1024, 'reason'),
    expectedFinanceVersion: version(value.expected_finance_version),
  };
}

export type PaymentExceptionPage = Readonly<{
  fundId: string;
  limit: number;
  after?: Readonly<{ at: string; id: string }>;
}>;
export function parsePaymentExceptionPage(input: {
  fundId: string;
  limit?: number;
  cursor?: string;
}): PaymentExceptionPage {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new PaymentInputError('Invalid limit');
  let after: PaymentExceptionPage['after'];
  if (input.cursor !== undefined) {
    try {
      if (!input.cursor || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
        throw new Error();
      const parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      if (
        parsed.version !== 1 ||
        parsed.fund !== input.fundId ||
        typeof parsed.at !== 'string' ||
        !Number.isFinite(new Date(parsed.at).getTime()) ||
        typeof parsed.id !== 'string'
      )
        throw new Error();
      after = { at: parsed.at, id: parsed.id };
    } catch {
      throw new PaymentInputError('Invalid cursor');
    }
  }
  return { fundId: input.fundId, limit, ...(after ? { after } : {}) };
}
export function paymentExceptionCursor(
  page: PaymentExceptionPage,
  row: { at: string; id: string },
) {
  return Buffer.from(
    JSON.stringify({ version: 1, fund: page.fundId, at: row.at, id: row.id }),
  ).toString('base64url');
}

export type MomoWebhookInput = Readonly<{
  partnerCode: string;
  orderId: string;
  requestId: string;
  amount: bigint;
  orderInfo: string;
  orderType: string;
  transactionId: string;
  resultCode: number;
  message: string;
  payType: string;
  responseTime: string;
  extraData: string;
  signature: string;
}>;
export function parseMomoWebhookInput(value: Record<string, unknown>): MomoWebhookInput {
  const token = (key: string, max: number) => text(value[key], max, key);
  const order = token('order_id', 100);
  const request = token('request_id', 100);
  if (!/^[0-9A-Za-z](?:[-_.]*[0-9A-Za-z]+)*$/.test(order) || !/^[0-9A-Za-z-]+$/.test(request))
    throw new PaymentInputError('Invalid MoMo identifiers');
  if (
    !Number.isInteger(value.result_code) ||
    Number(value.result_code) < 0 ||
    Number(value.result_code) > INT32_MAX
  )
    throw new PaymentInputError('Invalid result code');
  const transactionId = token('transaction_id', 40);
  const responseTime = token('response_time', 20);
  const extraData = typeof value.extra_data === 'string' ? value.extra_data : '';
  const signature = typeof value.signature === 'string' ? value.signature.toLowerCase() : '';
  if (
    !/^\d+$/.test(transactionId) ||
    !/^\d{10,20}$/.test(responseTime) ||
    extraData.length > 4096 ||
    (extraData !== '' && !/^[A-Za-z0-9+/]*={0,2}$/.test(extraData)) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    throw new PaymentInputError('Invalid MoMo payload');
  let amount: bigint;
  try {
    amount = parsePositiveVndAmount(value.amount);
  } catch {
    throw new PaymentInputError('Invalid amount');
  }
  return {
    partnerCode: token('partner_code', 100),
    orderId: order,
    requestId: request,
    amount,
    orderInfo: token('order_info', 255),
    orderType: token('order_type', 50),
    transactionId,
    resultCode: Number(value.result_code),
    message: token('message', 255),
    payType: token('pay_type', 50),
    responseTime,
    extraData,
    signature,
  };
}
