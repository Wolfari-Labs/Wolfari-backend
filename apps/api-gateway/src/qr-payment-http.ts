import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FinanceClient } from './finance-client';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  idempotencyKey,
  json,
  onlyKeys,
  requestBody,
  RequestError,
  responseRecord,
  uuid,
  type SessionValidator,
} from './trip-http';

export function qrPaymentRoute(path: string): string | undefined {
  return /^\/api\/v1\/trips\/([^/]+)\/qr-payments\/momo-sandbox$/.exec(path)?.[1];
}

export async function handleQrPayment(
  request: IncomingMessage & { body?: unknown },
  response: ServerResponse,
  url: URL,
  tripId: string,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  if (request.method !== 'POST') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const auth = await authenticate(request, response, validateSession, true);
  if (!auth) return;
  try {
    ensureQuery(url, []);
    if (!uuid.test(tripId)) throw new RequestError('Invalid trip');
    const body = await requestBody(request);
    onlyKeys(body, ['request_id', 'amount', 'note']);
    if (
      typeof body.request_id !== 'string' ||
      !uuid.test(body.request_id) ||
      idempotencyKey(request, true) !== body.request_id ||
      typeof body.amount !== 'string' ||
      !/^[1-9]\d{0,7}$/.test(body.amount) ||
      BigInt(body.amount) < 1000n ||
      BigInt(body.amount) > 50000000n ||
      typeof body.note !== 'string' ||
      body.note !== body.note.trim() ||
      !body.note ||
      [...body.note].length > 150 ||
      /[\u0000-\u001f\u007f]/.test(body.note)
    )
      throw new RequestError('Invalid sandbox checkout');
    const result = responseRecord(
      await client.call(
        'CreateQrSandboxPayment',
        {
          actor_user_id: auth.actorUserId,
          trip_id: tripId.toLowerCase(),
          request_id: body.request_id,
          amount: body.amount,
          note: body.note,
        },
        auth.correlationId,
      ),
    );
    if (
      result.request_id !== body.request_id ||
      result.amount !== body.amount ||
      result.environment !== 'SANDBOX' ||
      typeof result.order_id !== 'string' ||
      !/^wqr-[a-f0-9]{40}$/.test(result.order_id) ||
      typeof result.payment_url !== 'string'
    )
      throw new Error('Invalid sandbox response');
    const link = new URL(result.payment_url);
    if (
      link.protocol !== 'https:' ||
      link.hostname !== 'test-payment.momo.vn' ||
      link.username ||
      link.password ||
      link.port
    )
      throw new Error('Invalid sandbox URL');
    return json(response, 201, {
      data: {
        request_id: result.request_id,
        order_id: result.order_id,
        amount: result.amount,
        payment_url: link.href,
        environment: 'SANDBOX',
      },
      meta: { correlation_id: auth.correlationId },
    });
  } catch (cause) {
    if (cause instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, cause, true);
  }
}
