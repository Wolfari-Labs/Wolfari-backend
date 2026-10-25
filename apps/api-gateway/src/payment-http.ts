import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { currentCorrelationId } from '@wolfari/common';
import type { FinanceClient } from './finance-client';
import { projectOperation } from './membership-proxy';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  idempotencyKey,
  json,
  onlyKeys,
  RequestError,
  requestBody,
  requiredString,
  responseRecord,
  timestampToIso,
  uuid,
  type SessionValidator,
} from './trip-http';

type Request = IncomingMessage & { originalUrl?: string; body?: unknown };
export type PaymentRoute =
  | { kind: 'create'; contributionId: string }
  | { kind: 'attempt'; paymentAttemptId: string; reconcile: boolean }
  | { kind: 'webhook' }
  | { kind: 'exceptions'; fundId: string }
  | { kind: 'resolve'; paymentExceptionId: string };

export function paymentRoute(path: string): PaymentRoute | undefined {
  const create = /^\/api\/v1\/contributions\/([^/]+)\/payment-attempts$/.exec(path);
  if (create) return { kind: 'create', contributionId: create[1]! };
  const attempt = /^\/api\/v1\/payment-attempts\/([^/]+)(\/reconcile)?$/.exec(path);
  if (attempt)
    return {
      kind: 'attempt',
      paymentAttemptId: attempt[1]!,
      reconcile: Boolean(attempt[2]),
    };
  if (path === '/api/v1/webhooks/momo') return { kind: 'webhook' };
  const exceptions = /^\/api\/v1\/funds\/([^/]+)\/payment-exceptions$/.exec(path);
  if (exceptions) return { kind: 'exceptions', fundId: exceptions[1]! };
  const resolve = /^\/api\/v1\/payment-exceptions\/([^/]+)\/resolve$/.exec(path);
  return resolve ? { kind: 'resolve', paymentExceptionId: resolve[1]! } : undefined;
}

const identifier = (value: unknown) => {
  const result = requiredString(value);
  if (!uuid.test(result)) throw new Error('Invalid Payment ID');
  return result.toLowerCase();
};
const version = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647)
    throw new RequestError('Invalid version');
};
const reason = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\u0000') ||
    [...value.trim()].length > 1024
  )
    throw new RequestError('Invalid reason');
};
const integerString = (value: unknown, max: number) => {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== 'string' || !/^\d+$/.test(result) || result.length > max)
    throw new RequestError('Invalid provider integer');
  return result;
};
const noReadBody = (request: Request) => {
  if (
    (request.headers['content-length'] !== undefined &&
      request.headers['content-length'] !== '0') ||
    request.headers['transfer-encoding'] !== undefined
  )
    throw new RequestError('Invalid read body');
};

export function projectPaymentAttempt(value: unknown) {
  const row = responseRecord(value);
  const amount = requiredString(row.amount);
  if (
    !/^[1-9]\d*$/.test(amount) ||
    amount.length > 19 ||
    BigInt(amount) > 9_223_372_036_854_775_807n ||
    row.provider !== 'MOMO_SANDBOX' ||
    row.environment !== 'SANDBOX' ||
    row.currency !== 'VND' ||
    !['CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED'].includes(String(row.status)) ||
    typeof row.needs_reconciliation !== 'boolean'
  )
    throw new Error('Invalid Payment attempt');
  const paymentUrl = row.payment_url === undefined ? null : requiredString(row.payment_url);
  if (paymentUrl && !/^https:\/\/test-payment\.momo\.vn(?:\/|$)/.test(paymentUrl))
    throw new Error('Invalid Payment URL');
  return {
    id: identifier(row.id),
    contribution_id: identifier(row.contribution_id),
    provider: 'MOMO_SANDBOX',
    environment: 'SANDBOX',
    amount,
    currency: 'VND',
    status: String(row.status),
    needs_reconciliation: row.needs_reconciliation,
    payment_url: paymentUrl,
    expires_at: row.expires_at === undefined ? null : timestampToIso(row.expires_at),
    error_code: row.error_code === undefined ? null : requiredString(row.error_code),
    created_at: timestampToIso(row.created_at),
    updated_at: timestampToIso(row.updated_at),
  };
}

export function projectPaymentException(value: unknown) {
  const row = responseRecord(value);
  if (!['NEEDS_REVIEW', 'PROCESSED', 'IGNORED'].includes(String(row.processing_status)))
    throw new Error('Invalid Payment exception');
  const reviewReason = requiredString(row.review_reason);
  if (!reviewReason || reviewReason.length > 1024)
    throw new Error('Invalid Payment exception reason');
  return {
    id: identifier(row.id),
    payment_attempt_id:
      row.payment_attempt_id === undefined ? null : identifier(row.payment_attempt_id),
    processing_status: String(row.processing_status),
    review_reason: reviewReason,
    received_at: timestampToIso(row.received_at),
    reviewed_at: row.reviewed_at === undefined ? null : timestampToIso(row.reviewed_at),
  };
}

async function webhook(
  request: Request,
  response: ServerResponse,
  url: URL,
  client: Pick<FinanceClient, 'call'>,
) {
  if (request.method !== 'POST') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  try {
    ensureQuery(url, []);
    const body = await requestBody(request);
    onlyKeys(body, [
      'partnerCode',
      'orderId',
      'requestId',
      'amount',
      'orderInfo',
      'orderType',
      'transId',
      'resultCode',
      'message',
      'payType',
      'responseTime',
      'extraData',
      'signature',
    ]);
    for (const field of [
      'partnerCode',
      'orderId',
      'requestId',
      'orderInfo',
      'orderType',
      'message',
      'payType',
      'extraData',
      'signature',
    ])
      if (typeof body[field] !== 'string') throw new RequestError('Invalid MoMo payload');
    if (
      !Number.isInteger(body.resultCode) ||
      Number(body.resultCode) < 0 ||
      Number(body.resultCode) > 2_147_483_647
    )
      throw new RequestError('Invalid MoMo result');
    await client.call(
      'ReceiveMomoWebhook',
      {
        partner_code: body.partnerCode,
        order_id: body.orderId,
        request_id: body.requestId,
        amount: integerString(body.amount, 19),
        order_info: body.orderInfo,
        order_type: body.orderType,
        transaction_id: integerString(body.transId, 40),
        result_code: body.resultCode,
        message: body.message,
        pay_type: body.payType,
        response_time: integerString(body.responseTime, 20),
        extra_data: body.extraData,
        signature: body.signature,
      },
      currentCorrelationId() ?? randomUUID(),
    );
    response.statusCode = 204;
    response.setHeader('Cache-Control', 'no-store');
    return response.end();
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, true);
  }
}

export async function handlePayment(
  request: Request,
  response: ServerResponse,
  url: URL,
  route: PaymentRoute,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  if (route.kind === 'webhook') return webhook(request, response, url, client);
  const readAttempt = route.kind === 'attempt' && !route.reconcile && request.method === 'GET';
  const list = route.kind === 'exceptions' && request.method === 'GET';
  const create = route.kind === 'create' && request.method === 'POST';
  const reconcile = route.kind === 'attempt' && route.reconcile && request.method === 'POST';
  const resolve = route.kind === 'resolve' && request.method === 'POST';
  if (!readAttempt && !list && !create && !reconcile && !resolve)
    return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const write = create || reconcile || resolve;
  const auth = await authenticate(request, response, validateSession, write);
  if (!auth) return;
  try {
    const raw =
      route.kind === 'create'
        ? route.contributionId
        : route.kind === 'attempt'
          ? route.paymentAttemptId
          : route.kind === 'exceptions'
            ? route.fundId
            : route.paymentExceptionId;
    if (!uuid.test(raw)) throw new RequestError('Invalid Payment scope');
    const id = raw.toLowerCase();
    if (readAttempt || list) {
      ensureQuery(url, list ? ['limit', 'cursor'] : []);
      noReadBody(request);
      if (readAttempt) {
        const result = await client.call(
          'GetPaymentAttempt',
          { actor_user_id: auth.actorUserId, payment_attempt_id: id },
          auth.correlationId,
        );
        const data = projectPaymentAttempt(result.payment_attempt);
        if (data.id !== id) throw new Error('Payment attempt scope mismatch');
        return json(response, 200, { data, meta: { correlation_id: auth.correlationId } });
      }
      const rawLimit = url.searchParams.get('limit') ?? '20';
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if (
        !/^\d+$/.test(rawLimit) ||
        Number(rawLimit) < 1 ||
        Number(rawLimit) > 100 ||
        (cursor !== undefined &&
          (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)))
      )
        throw new RequestError('Invalid Payment exception query');
      const result = await client.call(
        'ListPaymentExceptions',
        {
          actor_user_id: auth.actorUserId,
          fund_id: id,
          limit: Number(rawLimit),
          cursor,
        },
        auth.correlationId,
      );
      if (!Array.isArray(result.items)) throw new Error('Invalid Payment exception list');
      return json(response, 200, {
        data: {
          items: result.items.map(projectPaymentException),
          next_cursor: result.next_cursor ?? null,
        },
        meta: { correlation_id: auth.correlationId },
      });
    }
    ensureQuery(url, []);
    const operationId = idempotencyKey(request, true)!;
    const body = await requestBody(request);
    let method: Parameters<FinanceClient['call']>[0];
    let payload: Record<string, unknown>;
    if (create) {
      onlyKeys(body, ['provider', 'expected_version', 'expected_finance_version']);
      if (body.provider !== 'MOMO_SANDBOX') throw new RequestError('Invalid provider');
      version(body.expected_version);
      version(body.expected_finance_version);
      method = 'CreatePaymentAttempt';
      payload = { ...body, contribution_id: id };
    } else if (reconcile) {
      onlyKeys(body, ['reason']);
      reason(body.reason);
      method = 'ReconcilePaymentAttempt';
      payload = { ...body, payment_attempt_id: id };
    } else {
      onlyKeys(body, ['resolution', 'linked_attempt_id', 'reason', 'expected_finance_version']);
      if (body.resolution !== 'LINKED' && body.resolution !== 'NO_FINANCIAL_EFFECT')
        throw new RequestError('Invalid resolution');
      if (
        (body.resolution === 'LINKED' &&
          (typeof body.linked_attempt_id !== 'string' || !uuid.test(body.linked_attempt_id))) ||
        (body.resolution === 'NO_FINANCIAL_EFFECT' && body.linked_attempt_id !== undefined)
      )
        throw new RequestError('Invalid linked attempt');
      reason(body.reason);
      version(body.expected_finance_version);
      method = 'ResolvePaymentException';
      payload = { ...body, payment_exception_id: id };
    }
    const result = await client.call(
      method,
      { ...payload, operation_id: operationId, actor_user_id: auth.actorUserId },
      auth.correlationId,
    );
    if (result.operation) {
      const operation = projectOperation(result.operation);
      if (operation.operation_id !== operationId)
        throw new Error('Payment operation scope mismatch');
      return json(response, 202, { data: operation, meta: { correlation_id: auth.correlationId } });
    }
    if (create) {
      const data = projectPaymentAttempt(result.payment_attempt);
      if (data.contribution_id !== id) throw new Error('Payment result scope mismatch');
      return json(response, 202, {
        data,
        meta: { correlation_id: auth.correlationId },
      });
    }
    const data = projectPaymentException(result.payment_exception);
    if (data.id !== id) throw new Error('Payment result scope mismatch');
    return json(response, 200, { data, meta: { correlation_id: auth.correlationId } });
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, write);
  }
}
