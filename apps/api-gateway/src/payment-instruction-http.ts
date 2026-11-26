import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseVietQrPayload, QR_SVG_MAX_BYTES, QR_SVG_SHAPE } from '@wolfari/common';
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

/**
 * Publishes only a self-consistent instruction: the QR payload must decode to exactly the bank,
 * account, amount and reference shown as text, and the SVG must be Finance's plain rendering.
 */
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
      'bank_name',
      'account_number',
      'qr_payload',
      'qr_svg',
      'environment',
      'warning',
    ].map((key) => [key, requiredString(r[key])]),
  ) as Record<string, string>;
  if (
    data.contribution_id !== id ||
    data.currency !== 'VND' ||
    data.environment !== 'LIVE' ||
    !/^[1-9]\d{0,12}$/.test(data.amount!) ||
    !/^[0-9A-Z]{25}$/.test(data.reference!) ||
    !/^\d{6}$/.test(data.bank_bin!) ||
    !/^[A-Za-z0-9][A-Za-z0-9 -]{0,29}$/.test(data.bank_code!) ||
    [...data.bank_name!].length > 100 ||
    [...data.recipient_name!].length > 150 ||
    !/^[a-zA-Z0-9]{1,19}$/.test(data.account_number!)
  )
    throw new Error('Invalid instruction');
  const transfer = parseVietQrPayload(data.qr_payload!);
  if (
    !transfer ||
    transfer.bankBin !== data.bank_bin ||
    transfer.accountNumber !== data.account_number ||
    transfer.amount !== data.amount ||
    transfer.addInfo !== data.reference
  )
    throw new Error('Invalid instruction payload');
  if (Buffer.byteLength(data.qr_svg!) > QR_SVG_MAX_BYTES || !QR_SVG_SHAPE.test(data.qr_svg!))
    throw new Error('Invalid instruction QR');
  // proto-loader omits an empty repeated field; only known checkouts are published.
  const providers = r.online_payment_providers ?? [];
  if (!Array.isArray(providers) || providers.some((item) => !ONLINE_PROVIDERS.has(item)))
    throw new Error('Invalid instruction providers');
  return { ...data, online_payment_providers: [...new Set(providers as string[])] };
}
const ONLINE_PROVIDERS = new Set<unknown>(['PAYOS']);

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
