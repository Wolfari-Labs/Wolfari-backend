import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FinanceClient } from './finance-client';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  RequestError,
  responseRecord,
  requiredInteger,
  requiredString,
  timestampToIso,
  uuid,
  type SessionValidator,
} from './trip-http';

const identifier = (value: unknown) => {
  const id = requiredString(value);
  if (!uuid.test(id)) throw new Error('Invalid history ID');
  return id;
};
const optionalId = (value: unknown) => (value === undefined ? null : identifier(value));
const version = (value: unknown) => {
  if (value === undefined) return null;
  const result = requiredInteger(value);
  if (result > 2147483647) throw new Error('Invalid history version');
  return result;
};
function instant(value: unknown) {
  const row = responseRecord(value);
  const base = timestampToIso(value);
  const nanos = row.nanos ?? 0;
  if (
    typeof nanos !== 'number' ||
    !Number.isInteger(nanos) ||
    nanos % 1000 !== 0 ||
    nanos < 0 ||
    nanos > 999999999
  )
    throw new Error('Invalid history timestamp');
  return base.slice(0, 19) + '.' + String(nanos / 1000).padStart(6, '0') + 'Z';
}
export function projectFundHistory(value: unknown, fundId: string, limit: number) {
  const page = responseRecord(value);
  const rows = page.items === undefined ? [] : page.items;
  if (!Array.isArray(rows) || rows.length > limit) throw new Error('Invalid history page');
  const items = rows.map((value) => {
    const row = responseRecord(value);
    const action = requiredString(row.action),
      entity = requiredString(row.entity_type);
    if (
      row.fund_id !== fundId ||
      !/^[A-Z][A-Z_]{0,59}$/.test(action) ||
      !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(entity) ||
      (row.system_actor !== undefined &&
        !['MOMO_IPN', 'MOMO_RECONCILIATION'].includes(requiredString(row.system_actor))) ||
      (row.reason !== undefined && (typeof row.reason !== 'string' || row.reason.length > 2000))
    )
      throw new Error('Invalid history record');
    return {
      id: identifier(row.id),
      fund_id: identifier(row.fund_id),
      actor_user_id: optionalId(row.actor_user_id),
      system_actor: row.system_actor ?? null,
      action,
      entity_type: entity,
      entity_id: optionalId(row.entity_id),
      from_version: version(row.from_version),
      to_version: version(row.to_version),
      reason: row.reason ?? null,
      occurred_at: instant(row.occurred_at),
      correlation_id: identifier(row.correlation_id),
    };
  });
  if (
    page.next_cursor !== undefined &&
    (typeof page.next_cursor !== 'string' ||
      page.next_cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(page.next_cursor) ||
      items.length === 0)
  )
    throw new Error('Invalid history cursor');
  return { items, next_cursor: page.next_cursor ?? null };
}

export async function handleFinanceHistory(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  fundId: string,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  if (request.method !== 'GET') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const auth = await authenticate(request, response, validateSession, false);
  if (!auth) return;
  try {
    ensureQuery(url, ['limit', 'cursor']);
    if (!uuid.test(fundId)) throw new RequestError('Invalid Fund');
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if ((rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) || limit < 1 || limit > 100)
      throw new RequestError('Invalid limit');
    const cursor = url.searchParams.get('cursor') ?? undefined;
    if (cursor !== undefined && (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)))
      throw new RequestError('Invalid cursor');
    const result = await client.call(
      'ListFundHistory',
      {
        fund_id: fundId.toLowerCase(),
        actor_user_id: auth.actorUserId,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      },
      auth.correlationId,
    );
    const data = projectFundHistory(result, fundId.toLowerCase(), limit);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(JSON.stringify({ data, meta: { correlation_id: auth.correlationId } }));
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, false);
  }
}
