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
export type ExpenseRoute =
  | { kind: 'collection'; fundId: string }
  | { kind: 'item'; expenseId: string; action?: 'submit' | 'withdraw' };

export function expenseRoute(path: string): ExpenseRoute | undefined {
  const collection = /^\/api\/v1\/funds\/([^/]+)\/expenses$/.exec(path);
  if (collection) return { kind: 'collection', fundId: collection[1]! };
  const item = /^\/api\/v1\/expenses\/([^/]+)(?:\/(submit|withdraw))?$/.exec(path);
  if (!item) return undefined;
  return {
    kind: 'item',
    expenseId: item[1]!,
    action: item[2] as 'submit' | 'withdraw' | undefined,
  };
}

const amount = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new RequestError('Invalid amount');
  const canonical = value.replace(/^0+/, '') || '0';
  if (canonical === '0' || canonical.length > 19 || BigInt(canonical) > 9223372036854775807n)
    throw new RequestError('Invalid amount');
};
const version = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    throw new RequestError('Invalid version');
};
const stringValue = (value: unknown, max: number, nullable = false) => {
  if (nullable && value === null) return;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\u0000') ||
    [...value.trim()].length > max
  )
    throw new RequestError('Invalid string');
};
const instant = (value: unknown, nullable = false) => {
  if (nullable && value === null) return;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(new Date(value).getTime())
  )
    throw new RequestError('Invalid instant');
};
const optionalFields = [
  ['description', 10000],
  ['category', 80],
  ['receipt_object_key', 1024],
  ['payment_method', 30],
] as const;
function validateWrite(body: Record<string, unknown>, create: boolean) {
  const fields = [
    'title',
    'description',
    'amount',
    'category',
    'receipt_object_key',
    'paid_at',
    'payment_method',
  ];
  onlyKeys(body, [...fields, 'expected_version', 'expected_finance_version']);
  if (create || Object.hasOwn(body, 'title')) stringValue(body.title, 200);
  if (create || Object.hasOwn(body, 'amount')) amount(body.amount);
  for (const [key, max] of optionalFields)
    if (Object.hasOwn(body, key)) stringValue(body[key], max, true);
  if (Object.hasOwn(body, 'paid_at')) instant(body.paid_at, true);
  if (!create && !fields.some((key) => Object.hasOwn(body, key)))
    throw new RequestError('Empty expense patch');
  version(body.expected_finance_version);
  if (!create) version(body.expected_version);
}
function validateAction(body: Record<string, unknown>) {
  onlyKeys(body, ['expected_version', 'expected_finance_version']);
  version(body.expected_version);
  version(body.expected_finance_version);
}
function identifier(value: unknown) {
  const result = requiredString(value);
  if (!uuid.test(result)) throw new Error('Invalid expense ID');
  return result.toLowerCase();
}
function nullableTimestamp(value: unknown) {
  return value === undefined || value === null ? null : timestampToIso(value);
}
export function projectExpense(value: unknown) {
  const row = responseRecord(value);
  if (!['DRAFT', 'SUBMITTED', 'CONFIRMED', 'REJECTED', 'REVERSED'].includes(String(row.status)))
    throw new Error('Invalid expense status');
  if (typeof row.receipt_available !== 'boolean') throw new Error('Invalid receipt flag');
  const money = requiredString(row.amount);
  if (!/^[1-9]\d*$/.test(money) || money.length > 19 || BigInt(money) > 9223372036854775807n)
    throw new Error('Invalid expense amount');
  return {
    id: identifier(row.id),
    fund_id: identifier(row.fund_id),
    title: requiredString(row.title),
    description: row.description === undefined ? null : requiredString(row.description),
    amount: money,
    category: row.category === undefined ? null : requiredString(row.category),
    status: String(row.status),
    created_by_user_id: identifier(row.created_by_user_id),
    receipt_available: row.receipt_available,
    submitted_at: nullableTimestamp(row.submitted_at),
    paid_at: nullableTimestamp(row.paid_at),
    payment_method: row.payment_method === undefined ? null : requiredString(row.payment_method),
    paid_by_user_id: row.paid_by_user_id === undefined ? null : identifier(row.paid_by_user_id),
    confirmed_at: nullableTimestamp(row.confirmed_at),
    confirmed_by_user_id:
      row.confirmed_by_user_id === undefined ? null : identifier(row.confirmed_by_user_id),
    rejected_reason: row.rejected_reason === undefined ? null : requiredString(row.rejected_reason),
    created_at: timestampToIso(row.created_at),
    updated_at: timestampToIso(row.updated_at),
    version: requiredInteger(row.version),
    finance_version: requiredInteger(row.finance_version),
  };
}

export async function handleExpense(
  request: Request,
  response: ServerResponse,
  url: URL,
  route: ExpenseRoute,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  const list = route.kind === 'collection' && request.method === 'GET';
  const create = route.kind === 'collection' && request.method === 'POST';
  const update = route.kind === 'item' && !route.action && request.method === 'PATCH';
  const remove = route.kind === 'item' && !route.action && request.method === 'DELETE';
  const action = route.kind === 'item' && route.action && request.method === 'POST';
  if (!list && !create && !update && !remove && !action)
    return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const write = !list;
  const auth = await authenticate(request, response, validateSession, write);
  if (!auth) return;
  try {
    const rawId = route.kind === 'collection' ? route.fundId : route.expenseId;
    if (!uuid.test(rawId)) throw new RequestError('Invalid expense scope');
    const id = rawId.toLowerCase();
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
          !['DRAFT', 'SUBMITTED', 'CONFIRMED', 'REJECTED', 'REVERSED'].includes(status))
      )
        throw new RequestError('Invalid expense query');
      const limit = Number(rawLimit);
      const result = await client.call(
        'ListExpenses',
        { actor_user_id: auth.actorUserId, fund_id: id, limit, cursor, status },
        auth.correlationId,
      );
      if (!Array.isArray(result.items)) throw new Error('Invalid expense list');
      const items = result.items.map(projectExpense);
      if (items.some((item) => item.fund_id !== id)) throw new Error('Expense scope mismatch');
      const next = result.next_cursor;
      if (next !== undefined && (typeof next !== 'string' || !next || next.length > 1024))
        throw new Error('Invalid expense cursor');
      return json(response, 200, {
        data: { items, next_cursor: next ?? null },
        meta: { correlation_id: auth.correlationId },
      });
    }
    const operationId = idempotencyKey(request, true);
    const body = await requestBody(request);
    if (create || update) validateWrite(body, create);
    else validateAction(body);
    let method:
      'CreateExpense' | 'UpdateExpense' | 'DeleteExpense' | 'SubmitExpense' | 'WithdrawExpense';
    let payload: Record<string, unknown>;
    if (create) {
      method = 'CreateExpense';
      payload = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null));
      payload.fund_id = id;
    } else if (update) {
      method = 'UpdateExpense';
      payload = {
        expected_version: body.expected_version,
        expected_finance_version: body.expected_finance_version,
      };
      for (const key of ['title', 'amount']) if (Object.hasOwn(body, key)) payload[key] = body[key];
      for (const key of [
        'description',
        'category',
        'receipt_object_key',
        'paid_at',
        'payment_method',
      ])
        if (Object.hasOwn(body, key))
          payload[key] = body[key] === null ? { clear: true } : { value: body[key] };
      payload.expense_id = id;
    } else {
      method = remove
        ? 'DeleteExpense'
        : route.kind === 'item' && route.action === 'submit'
          ? 'SubmitExpense'
          : 'WithdrawExpense';
      payload = { ...body, expense_id: id };
    }
    const result = await client.call(
      method,
      { ...payload, operation_id: operationId, actor_user_id: auth.actorUserId },
      auth.correlationId,
    );
    if (result.operation) {
      const operation = projectOperation(result.operation);
      if (operation.operation_id !== operationId) throw new Error('Expense operation mismatch');
      const pending = ['PROCESSING', 'PENDING_RECOVERY', 'NEEDS_REVIEW'].includes(operation.state);
      if (!pending && !(remove && operation.state === 'SUCCEEDED'))
        throw new Error('Invalid expense operation state');
      return json(response, pending ? 202 : 200, {
        data: operation,
        meta: { correlation_id: auth.correlationId },
      });
    }
    if (remove) throw new Error('Missing delete operation');
    const data = projectExpense(result.expense);
    if ((create && data.fund_id !== id) || (!create && data.id !== id))
      throw new Error('Expense result scope mismatch');
    return json(response, create ? 201 : 200, {
      data,
      meta: { correlation_id: auth.correlationId },
    });
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, write);
  }
}
