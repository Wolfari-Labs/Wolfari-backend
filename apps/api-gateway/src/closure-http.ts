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
type Action = 'confirm' | 'cancel' | 'remind';
export type ClosureRoute =
  { kind: 'collection'; fundId: string } | { kind: 'item'; closureId: string; action?: Action };
export function closureRoute(path: string): ClosureRoute | undefined {
  const collection = /^\/api\/v1\/funds\/([^/]+)\/closures$/.exec(path);
  if (collection) return { kind: 'collection', fundId: collection[1]! };
  const item = /^\/api\/v1\/closures\/([^/]+)(?:\/(confirm|cancel|remind))?$/.exec(path);
  return item
    ? { kind: 'item', closureId: item[1]!, action: item[2] as Action | undefined }
    : undefined;
}
const identifier = (value: unknown) => {
  const id = requiredString(value);
  if (!uuid.test(id)) throw new Error('Invalid closure ID');
  return id.toLowerCase();
};
const version = (value: unknown) => {
  const result = requiredInteger(value);
  if (result > 2147483647) throw new Error('Invalid closure version');
  return result;
};
const nullableTimestamp = (value: unknown) =>
  value === undefined || value === null ? null : timestampToIso(value);
const exactRecord = (value: unknown, keys: readonly string[]) => {
  const row = responseRecord(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error('Invalid closure snapshot');
  return row;
};
const snapshotRows = (value: unknown, keys: readonly string[]) => {
  if (!Array.isArray(value)) throw new Error('Invalid closure snapshot');
  return value.map((item) => exactRecord(item, keys));
};
const snapshotKeys = {
  contribution_requests: [
    'id',
    'title',
    'amount_per_member',
    'due_at',
    'status',
    'created_by_user_id',
    'created_at',
    'closed_at',
    'note',
    'version',
  ],
  contributions: [
    'id',
    'request_id',
    'member_user_id',
    'amount',
    'status',
    'self_contribution',
    'member_reported_at',
    'confirmed_by_user_id',
    'confirmed_at',
    'waived_reason',
    'cancelled_reason',
    'waived_at',
    'cancelled_at',
    'reversed_at',
    'created_at',
    'updated_at',
    'version',
  ],
  expenses: [
    'id',
    'title',
    'description',
    'amount',
    'status',
    'created_by_user_id',
    'submitted_at',
    'confirmed_at',
    'cancelled_at',
    'cancelled_reason',
    'category',
    'paid_at',
    'payment_method',
    'paid_by_user_id',
    'rejected_reason',
    'created_at',
    'updated_at',
    'version',
  ],
  financial_notes: [
    'id',
    'payer_user_id',
    'amount',
    'description',
    'created_by_user_id',
    'version',
    'created_at',
    'updated_at',
  ],
  refunds: [
    'id',
    'member_user_id',
    'amount',
    'status',
    'reason',
    'holder_reported_at',
    'confirmed_at',
    'nonreceipt_confirmed_at',
    'reversal_requested_at',
    'reversal_consented_at',
    'created_at',
    'updated_at',
    'version',
  ],
  ledger: [
    'id',
    'sequence',
    'direction',
    'transaction_type',
    'amount',
    'balance_after',
    'contribution_id',
    'expense_id',
    'refund_id',
    'reversal_of_id',
    'actor_user_id',
    'reason',
    'created_at',
  ],
} as const;
function projectSnapshot(value: unknown) {
  const row = exactRecord(value, [
    'schema_version',
    'fund',
    'required_user_ids',
    ...Object.keys(snapshotKeys),
  ]);
  if (row.schema_version !== 1 || !Array.isArray(row.required_user_ids))
    throw new Error('Invalid closure snapshot');
  const fund = exactRecord(row.fund, [
    'id',
    'trip_id',
    'holder_user_id',
    'currency',
    'budget_amount',
    'current_balance',
    'finance_version',
  ]);
  return {
    schema_version: 1,
    fund,
    required_user_ids: row.required_user_ids.map(identifier),
    contribution_requests: snapshotRows(
      row.contribution_requests,
      snapshotKeys.contribution_requests,
    ),
    contributions: snapshotRows(row.contributions, snapshotKeys.contributions),
    expenses: snapshotRows(row.expenses, snapshotKeys.expenses),
    financial_notes: snapshotRows(row.financial_notes, snapshotKeys.financial_notes),
    refunds: snapshotRows(row.refunds, snapshotKeys.refunds),
    ledger: snapshotRows(row.ledger, snapshotKeys.ledger),
  };
}
export function projectClosure(value: unknown) {
  const row = responseRecord(value);
  if (!['PENDING_CONFIRMATIONS', 'CANCELLED', 'COMPLETED'].includes(String(row.status)))
    throw new Error('Invalid closure status');
  const hash = requiredString(row.snapshot_hash);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid closure hash');
  let snapshot: ReturnType<typeof projectSnapshot>;
  try {
    snapshot = projectSnapshot(JSON.parse(requiredString(row.snapshot_json)));
  } catch {
    throw new Error('Invalid closure snapshot');
  }
  const closureId = identifier(row.id);
  const fundId = identifier(row.fund_id);
  const snapshotFinanceVersion = version(row.snapshot_finance_version);
  const snapshotSchemaVersion = version(row.snapshot_schema_version);
  if (
    snapshotSchemaVersion !== snapshot.schema_version ||
    identifier(snapshot.fund.id) !== fundId ||
    version(snapshot.fund.finance_version) !== snapshotFinanceVersion
  )
    throw new Error('Closure snapshot mismatch');
  const confirmations = Array.isArray(row.confirmations)
    ? row.confirmations.map((value) => {
        const item = responseRecord(value);
        return {
          user_id: identifier(item.user_id),
          confirmed_at: nullableTimestamp(item.confirmed_at),
        };
      })
    : (() => {
        throw new Error('Invalid closure confirmations');
      })();
  const required = snapshot.required_user_ids;
  if (
    required.length !== confirmations.length ||
    required.some((id, index) => id !== confirmations[index]?.user_id)
  )
    throw new Error('Closure confirmation mismatch');
  return {
    id: closureId,
    fund_id: fundId,
    requested_by_user_id: identifier(row.requested_by_user_id),
    status: String(row.status),
    snapshot_finance_version: snapshotFinanceVersion,
    snapshot_schema_version: snapshotSchemaVersion,
    snapshot,
    snapshot_hash: hash,
    requested_at: timestampToIso(row.requested_at),
    cancelled_at: nullableTimestamp(row.cancelled_at),
    cancelled_reason:
      row.cancelled_reason === undefined ? null : requiredString(row.cancelled_reason),
    closed_at: nullableTimestamp(row.closed_at),
    confirmations,
    finance_version: version(row.finance_version),
  };
}
const inputVersion = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    throw new RequestError('Invalid version');
};
const reason = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    [...value.trim()].length > 1024
  )
    throw new RequestError('Invalid reason');
};

export async function handleClosure(
  request: Request,
  response: ServerResponse,
  url: URL,
  route: ClosureRoute,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  const list = route.kind === 'collection' && request.method === 'GET';
  const create = route.kind === 'collection' && request.method === 'POST';
  const get = route.kind === 'item' && route.action === undefined && request.method === 'GET';
  const action = route.kind === 'item' && route.action !== undefined && request.method === 'POST';
  if (!list && !create && !get && !action) return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const write = create || action;
  const auth = await authenticate(request, response, validateSession, write);
  if (!auth) return;
  try {
    const raw = route.kind === 'collection' ? route.fundId : route.closureId;
    if (!uuid.test(raw)) throw new RequestError('Invalid closure scope');
    const id = raw.toLowerCase();
    if (list || get) {
      ensureQuery(url, list ? ['limit', 'cursor'] : []);
      if (
        (request.headers['content-length'] !== undefined &&
          request.headers['content-length'] !== '0') ||
        request.headers['transfer-encoding'] !== undefined
      )
        throw new RequestError('Invalid read body');
      const method = list ? 'ListClosures' : 'GetClosure';
      const rawLimit = url.searchParams.get('limit') ?? '20';
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if (
        list &&
        (!/^\d+$/.test(rawLimit) ||
          Number(rawLimit) < 1 ||
          Number(rawLimit) > 100 ||
          (cursor !== undefined &&
            (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))))
      )
        throw new RequestError('Invalid closure query');
      const result = await client.call(
        method,
        list
          ? { actor_user_id: auth.actorUserId, fund_id: id, limit: Number(rawLimit), cursor }
          : { actor_user_id: auth.actorUserId, closure_id: id },
        auth.correlationId,
      );
      if (list) {
        if (!Array.isArray(result.items)) throw new Error('Invalid closure list');
        const items = result.items.map(projectClosure);
        if (items.some((item) => item.fund_id !== id)) throw new Error('Closure scope mismatch');
        return json(response, 200, {
          data: { items, next_cursor: result.next_cursor ?? null },
          meta: { correlation_id: auth.correlationId },
        });
      }
      const data = projectClosure(result.closure);
      if (data.id !== id) throw new Error('Closure scope mismatch');
      return json(response, 200, { data, meta: { correlation_id: auth.correlationId } });
    }
    const operationId = idempotencyKey(request, true);
    const body = await requestBody(request);
    let method: Parameters<FinanceClient['call']>[0];
    if (create) {
      onlyKeys(body, ['expected_finance_version']);
      inputVersion(body.expected_finance_version);
      method = 'CreateClosure';
    } else {
      const selected = (route as Extract<ClosureRoute, { kind: 'item' }>).action!;
      if (selected === 'confirm') {
        onlyKeys(body, ['snapshot_hash']);
        if (typeof body.snapshot_hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.snapshot_hash))
          throw new RequestError('Invalid snapshot hash');
        method = 'ConfirmClosure';
      } else if (selected === 'cancel') {
        onlyKeys(body, ['reason']);
        reason(body.reason);
        method = 'CancelClosure';
      } else {
        onlyKeys(body, []);
        method = 'RemindClosure';
      }
    }
    const result = await client.call(
      method,
      {
        ...body,
        operation_id: operationId,
        actor_user_id: auth.actorUserId,
        [create ? 'fund_id' : 'closure_id']: id,
      },
      auth.correlationId,
    );
    if (result.operation) {
      const operation = projectOperation(result.operation);
      if (
        operation.operation_id !== operationId ||
        !['PROCESSING', 'PENDING_RECOVERY', 'NEEDS_REVIEW'].includes(operation.state)
      )
        throw new Error('Invalid closure operation');
      return json(response, 202, { data: operation, meta: { correlation_id: auth.correlationId } });
    }
    const data = projectClosure(result.closure);
    if ((create && data.fund_id !== id) || (!create && data.id !== id))
      throw new Error('Closure result scope mismatch');
    if (!create && route.kind === 'item' && route.action === 'remind')
      return json(response, 202, {
        data: { accepted: true, operation_id: operationId, closure_id: data.id },
        meta: { correlation_id: auth.correlationId },
      });
    return json(response, create ? 201 : 200, {
      data,
      meta: { correlation_id: auth.correlationId },
    });
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, write);
  }
}
