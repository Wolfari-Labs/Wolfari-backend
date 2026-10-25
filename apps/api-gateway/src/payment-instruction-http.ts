import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FinanceClient } from './finance-client';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  requiredString,
  responseRecord,
  uuid,
  RequestError,
  type SessionValidator,
} from './trip-http';

export function projectPaymentInstruction(value: unknown, id: string) {
  const r = responseRecord(value);
  const data = Object.fromEntries(
    [
      'contribution_id',
      'amount',
      'currency',
      'reference',
      'recipient_name',
      'bank_code',
      'bank_bin',
      'account_number',
      'qr_url',
      'environment',
      'warning',
    ].map((key) => [key, requiredString(r[key])]),
  ) as Record<string, string>;
  if (
    data.contribution_id !== id ||
    data.currency !== 'VND' ||
    data.environment !== 'TEST' ||
    !/^[1-9]\d{0,12}$/.test(data.amount!) ||
    !/^[0-9A-Z]{25}$/.test(data.reference!) ||
    !/^\d{6}$/.test(data.bank_bin!) ||
    !/^[a-zA-Z0-9]{1,19}$/.test(data.account_number!)
  )
    throw new Error('Invalid instruction');
  const expected = new URL(
    `https://img.vietqr.io/image/${data.bank_bin}-${data.account_number}-compact2.svg`,
  );
  expected.searchParams.set('amount', data.amount!);
  expected.searchParams.set('addInfo', data.reference!);
  expected.searchParams.set('accountName', data.recipient_name!);
  if (data.qr_url !== expected.toString()) throw new Error('Invalid instruction URL');
  return data;
}

export async function handlePaymentInstruction(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  id: string,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const auth = await authenticate(request, response, validateSession, false);
  if (!auth) return;
  try {
    ensureQuery(url, []);
    if (!uuid.test(id)) throw new RequestError('Invalid ID');
    const result = await client.call(
      'GetPaymentInstruction',
      {
        contribution_id: id.toLowerCase(),
        actor_user_id: auth.actorUserId,
      },
      auth.correlationId,
    );
    const data = projectPaymentInstruction(result.instruction, id.toLowerCase());
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'private, no-store');
    response.end(JSON.stringify({ data, meta: { correlation_id: auth.correlationId } }));
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, true);
  }
}
