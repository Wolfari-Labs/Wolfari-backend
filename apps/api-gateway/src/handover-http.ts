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
type Action = 'accept' | 'refresh-snapshot' | 'confirm' | 'cancel';
export type HandoverRoute =
  { kind: 'collection'; fundId: string } | { kind: 'item'; handoverId: string; action?: Action };
export function handoverRoute(path: string): HandoverRoute | undefined {
  const collection = /^\/api\/v1\/funds\/([^/]+)\/holder-handovers$/.exec(path);
  if (collection) return { kind: 'collection', fundId: collection[1]! };
  const item =
    /^\/api\/v1\/holder-handovers\/([^/]+)(?:\/(accept|refresh-snapshot|confirm|cancel))?$/.exec(
      path,
    );
  return item
    ? { kind: 'item', handoverId: item[1]!, action: item[2] as Action | undefined }
    : undefined;
}
function identifier(value: unknown) {
  const id = requiredString(value);
  if (!uuid.test(id)) throw new Error('Invalid handover identifier');
  return id.toLowerCase();
}
function inputVersion(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    throw new RequestError('Invalid version');
}
const time = (value: unknown) =>
  value === undefined || value === null ? null : timestampToIso(value);
const money = (value: unknown) => {
  const s = requiredString(value);
  if (!/^(0|[1-9]\d*)$/.test(s) || s.length > 19 || BigInt(s) > 9223372036854775807n)
    throw new Error('Invalid handover amount');
  return s;
};
export function projectHandover(value: unknown) {
  const row = responseRecord(value);
  if (
    !['NOMINATED', 'ACCEPTED', 'COMPLETED', 'CANCELLED'].includes(String(row.status)) ||
    typeof row.snapshot_stale !== 'boolean'
  )
    throw new Error('Invalid handover state');
  let snapshot: Record<string, unknown> | null = null;
  if (row.snapshot !== undefined && row.snapshot !== null) {
    const s = responseRecord(row.snapshot);
    const arrays = [
      'pending_contribution_ids',
      'pending_refund_ids',
      'pending_expense_ids',
      'pending_payment_ids',
      'payment_destination_ids',
      'pending_payment_exception_ids',
    ];
    if (!/^[a-f0-9]{64}$/.test(String(s.fingerprint)))
      throw new Error('Invalid snapshot fingerprint');
    snapshot = {
      current_balance: money(s.current_balance),
      reserved_refund: money(s.reserved_refund),
      available_balance: money(s.available_balance),
      ledger_sequence: money(s.ledger_sequence),
      fingerprint: s.fingerprint,
    };
    for (const key of arrays) {
      const ids = s[key] ?? [];
      if (!Array.isArray(ids)) throw new Error('Invalid snapshot IDs');
      snapshot[key] = ids.map(identifier);
    }
  }
  return {
    id: identifier(row.id),
    fund_id: identifier(row.fund_id),
    old_holder_user_id: identifier(row.old_holder_user_id),
    new_holder_user_id: identifier(row.new_holder_user_id),
    nominated_by_user_id: identifier(row.nominated_by_user_id),
    status: String(row.status),
    version: requiredInteger(row.version),
    finance_version: requiredInteger(row.finance_version),
    snapshot_finance_version:
      row.snapshot_finance_version === undefined
        ? null
        : requiredInteger(row.snapshot_finance_version),
    snapshot,
    snapshot_stale: row.snapshot_stale,
    accepted_at: time(row.accepted_at),
    old_holder_confirmed_at: time(row.old_holder_confirmed_at),
    new_holder_confirmed_at: time(row.new_holder_confirmed_at),
    completed_at: time(row.completed_at),
    cancelled_at: time(row.cancelled_at),
    cancellation_reason: row.cancellation_reason ?? null,
    created_at: timestampToIso(row.created_at),
    updated_at: timestampToIso(row.updated_at),
  };
}
export async function handleHandover(
  request: Request,
  response: ServerResponse,
  url: URL,
  route: HandoverRoute,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  const list = route.kind === 'collection' && request.method === 'GET';
  const get = route.kind === 'item' && !route.action && request.method === 'GET';
  const create = route.kind === 'collection' && request.method === 'POST';
  const action = route.kind === 'item' && route.action && request.method === 'POST';
  if (!list && !get && !create && !action) return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const read = list || get,
    auth = await authenticate(request, response, validateSession, !read);
  if (!auth) return;
  try {
    ensureQuery(url, []);
    const raw = route.kind === 'collection' ? route.fundId : route.handoverId;
    if (!uuid.test(raw)) throw new RequestError('Invalid handover ID');
    const id = raw.toLowerCase();
    if (read) {
      if (
        (request.headers['content-length'] !== undefined &&
          request.headers['content-length'] !== '0') ||
        request.headers['transfer-encoding'] !== undefined
      )
        throw new RequestError('Invalid read body');
      const result = await client.call(
        list ? 'ListHolderHandovers' : 'GetHolderHandover',
        { actor_user_id: auth.actorUserId, ...(list ? { fund_id: id } : { handover_id: id }) },
        auth.correlationId,
      );
      const data = list
        ? {
            items: (() => {
              if (!Array.isArray(result.items)) throw new Error('Invalid handover list');
              const items = result.items.map(projectHandover);
              if (items.some((x) => x.fund_id !== id)) throw new Error('Wrong Fund');
              return items;
            })(),
          }
        : projectHandover(result.handover);
      if (!list && 'id' in data && data.id !== id) throw new Error('Wrong handover');
      return json(response, 200, { data, meta: { correlation_id: auth.correlationId } });
    }
    const operationId = idempotencyKey(request, true),
      body = await requestBody(request);
    let method: Parameters<FinanceClient['call']>[0];
    if (create) {
      onlyKeys(body, ['new_holder_user_id', 'expected_finance_version']);
      if (!uuid.test(String(body.new_holder_user_id))) throw new RequestError('Invalid successor');
      inputVersion(body.expected_finance_version);
      method = 'CreateHolderHandover';
    } else {
      const kind = (route as Extract<HandoverRoute, { kind: 'item' }>).action!;
      onlyKeys(body, [
        'expected_version',
        'expected_finance_version',
        ...(kind === 'confirm' ? ['expected_snapshot_finance_version'] : []),
        ...(kind === 'cancel' ? ['reason'] : []),
      ]);
      inputVersion(body.expected_version);
      inputVersion(body.expected_finance_version);
      if (kind === 'confirm') inputVersion(body.expected_snapshot_finance_version);
      if (
        kind === 'cancel' &&
        (typeof body.reason !== 'string' ||
          !body.reason.trim() ||
          body.reason.includes('\u0000') ||
          [...body.reason.trim()].length > 1024)
      )
        throw new RequestError('Invalid cancellation reason');
      method = {
        accept: 'AcceptHolderHandover',
        'refresh-snapshot': 'RefreshHolderHandover',
        confirm: 'ConfirmHolderHandover',
        cancel: 'CancelHolderHandover',
      }[kind] as Parameters<FinanceClient['call']>[0];
    }
    const result = await client.call(
      method,
      {
        ...body,
        actor_user_id: auth.actorUserId,
        operation_id: operationId,
        ...(create ? { fund_id: id } : { handover_id: id }),
      },
      auth.correlationId,
    );
    if (result.operation) {
      const operation = projectOperation(result.operation);
      if (
        operation.operation_id !== operationId ||
        !['PROCESSING', 'PENDING_RECOVERY', 'NEEDS_REVIEW'].includes(operation.state)
      )
        throw new Error('Invalid operation');
      return json(response, 202, { data: operation, meta: { correlation_id: auth.correlationId } });
    }
    const data = projectHandover(result.handover);
    if ((create && data.fund_id !== id) || (!create && data.id !== id))
      throw new Error('Wrong handover result');
    return json(response, create ? 201 : 200, {
      data,
      meta: { correlation_id: auth.correlationId },
    });
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, !read);
  }
}
