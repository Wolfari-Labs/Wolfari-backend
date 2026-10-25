import type { IncomingMessage, ServerResponse } from 'node:http';
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
  requiredInteger,
  requiredString,
  responseRecord,
  timestampToIso,
  uuid,
  type SessionValidator,
} from './trip-http';

type Request = IncomingMessage & { originalUrl?: string; body?: unknown };
type Action =
  | 'report-paid'
  | 'confirm-received'
  | 'confirm-nonreceipt'
  | 'cancel'
  | 'request-reversal'
  | 'consent-reversal'
  | 'reverse';
export type RefundRoute =
  { kind: 'collection'; fundId: string } | { kind: 'item'; refundId: string; action: Action };

export function refundRoute(path: string): RefundRoute | undefined {
  const collection = /^\/api\/v1\/funds\/([^/]+)\/refunds$/.exec(path);
  if (collection) return { kind: 'collection', fundId: collection[1]! };
  const item =
    /^\/api\/v1\/refunds\/([^/]+)\/(report-paid|confirm-received|confirm-nonreceipt|cancel|request-reversal|consent-reversal|reverse)$/.exec(
      path,
    );
  return item ? { kind: 'item', refundId: item[1]!, action: item[2] as Action } : undefined;
}
const version = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    throw new RequestError('Invalid version');
};
const identifier = (value: unknown) => {
  const result = requiredString(value);
  if (!uuid.test(result)) throw new Error('Invalid refund ID');
  return result.toLowerCase();
};
const inputAmount = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new RequestError('Invalid amount');
  const canonical = value.replace(/^0+/, '') || '0';
  if (canonical === '0' || canonical.length > 19 || BigInt(canonical) > 9223372036854775807n)
    throw new RequestError('Invalid amount');
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
const nullableTimestamp = (value: unknown) =>
  value === undefined || value === null ? null : timestampToIso(value);
export function projectRefund(value: unknown) {
  const row = responseRecord(value);
  if (
    !['PENDING', 'HOLDER_REPORTED', 'CONFIRMED', 'CANCELLED', 'REVERSED'].includes(
      String(row.status),
    )
  )
    throw new Error('Invalid refund status');
  const amount = requiredString(row.amount);
  if (!/^[1-9]\d*$/.test(amount) || amount.length > 19 || BigInt(amount) > 9223372036854775807n)
    throw new Error('Invalid refund amount');
  return {
    id: identifier(row.id),
    fund_id: identifier(row.fund_id),
    member_user_id: identifier(row.member_user_id),
    amount,
    status: String(row.status),
    reason: requiredString(row.reason),
    holder_reported_at: nullableTimestamp(row.holder_reported_at),
    confirmed_at: nullableTimestamp(row.confirmed_at),
    nonreceipt_confirmed_at: nullableTimestamp(row.nonreceipt_confirmed_at),
    reversal_requested_at: nullableTimestamp(row.reversal_requested_at),
    reversal_consented_at: nullableTimestamp(row.reversal_consented_at),
    created_at: timestampToIso(row.created_at),
    updated_at: timestampToIso(row.updated_at),
    version: requiredInteger(row.version),
    finance_version: requiredInteger(row.finance_version),
  };
}
function validateAction(body: Record<string, unknown>, withReason: boolean) {
  onlyKeys(
    body,
    withReason
      ? ['reason', 'expected_version', 'expected_finance_version']
      : ['expected_version', 'expected_finance_version'],
  );
  if (withReason) reason(body.reason);
  version(body.expected_version);
  version(body.expected_finance_version);
}

export async function handleRefund(
  request: Request,
  response: ServerResponse,
  url: URL,
  route: RefundRoute,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  const list = route.kind === 'collection' && request.method === 'GET';
  const create = route.kind === 'collection' && request.method === 'POST';
  const action = route.kind === 'item' && request.method === 'POST';
  if (!list && !create && !action) return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const auth = await authenticate(request, response, validateSession, !list);
  if (!auth) return;
  try {
    const raw = route.kind === 'collection' ? route.fundId : route.refundId;
    if (!uuid.test(raw)) throw new RequestError('Invalid refund scope');
    const id = raw.toLowerCase();
    if (list) {
      ensureQuery(url, ['limit', 'cursor', 'status']);
      if (
        (request.headers['content-length'] !== undefined &&
          request.headers['content-length'] !== '0') ||
        request.headers['transfer-encoding'] !== undefined
      )
        throw new RequestError('Invalid read body');
      const rawLimit = url.searchParams.get('limit') ?? '20';
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const status = url.searchParams.get('status') ?? undefined;
      if (
        !/^\d+$/.test(rawLimit) ||
        Number(rawLimit) < 1 ||
        Number(rawLimit) > 100 ||
        (cursor !== undefined &&
          (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))) ||
        (status !== undefined &&
          !['PENDING', 'HOLDER_REPORTED', 'CONFIRMED', 'CANCELLED', 'REVERSED'].includes(status))
      )
        throw new RequestError('Invalid refund query');
      const result = await client.call(
        'ListRefunds',
        { actor_user_id: auth.actorUserId, fund_id: id, limit: Number(rawLimit), cursor, status },
        auth.correlationId,
      );
      if (!Array.isArray(result.items)) throw new Error('Invalid refund list');
      const items = result.items.map(projectRefund);
      if (items.some((item) => item.fund_id !== id)) throw new Error('Refund scope mismatch');
      return json(response, 200, {
        data: { items, next_cursor: result.next_cursor ?? null },
        meta: { correlation_id: auth.correlationId },
      });
    }
    const operationId = idempotencyKey(request, true);
    const body = await requestBody(request);
    let method: Parameters<FinanceClient['call']>[0];
    let payload: Record<string, unknown>;
    if (create) {
      onlyKeys(body, ['member_user_id', 'amount', 'reason', 'expected_finance_version']);
      if (!uuid.test(String(body.member_user_id))) throw new RequestError('Invalid member');
      inputAmount(body.amount);
      reason(body.reason);
      version(body.expected_finance_version);
      method = 'CreateRefund';
      payload = { ...body, fund_id: id };
    } else {
      const withReason =
        route.kind === 'item' &&
        ['confirm-nonreceipt', 'cancel', 'request-reversal', 'reverse'].includes(route.action);
      validateAction(body, withReason);
      const methods: Record<Action, Parameters<FinanceClient['call']>[0]> = {
        'report-paid': 'ReportRefundPaid',
        'confirm-received': 'ConfirmRefundReceived',
        'confirm-nonreceipt': 'ConfirmRefundNonreceipt',
        cancel: 'CancelRefund',
        'request-reversal': 'RequestRefundReversal',
        'consent-reversal': 'ConsentRefundReversal',
        reverse: 'ReverseRefund',
      };
      method = methods[(route as Extract<RefundRoute, { kind: 'item' }>).action];
      payload = { ...body, refund_id: id };
    }
    const result = await client.call(
      method,
      { ...payload, operation_id: operationId, actor_user_id: auth.actorUserId },
      auth.correlationId,
    );
    if (result.operation) {
      const operation = projectOperation(result.operation);
      if (
        operation.operation_id !== operationId ||
        !['PROCESSING', 'PENDING_RECOVERY', 'NEEDS_REVIEW'].includes(operation.state)
      )
        throw new Error('Invalid refund operation');
      return json(response, 202, { data: operation, meta: { correlation_id: auth.correlationId } });
    }
    const data = projectRefund(result.refund);
    if ((create && data.fund_id !== id) || (!create && data.id !== id))
      throw new Error('Refund result scope mismatch');
    return json(response, create ? 201 : 200, {
      data,
      meta: { correlation_id: auth.correlationId },
    });
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, !list);
  }
}
