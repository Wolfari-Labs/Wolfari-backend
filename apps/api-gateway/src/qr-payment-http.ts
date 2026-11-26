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
  return /^\/api\/v1\/trips\/([^/]+)\/qr-payments\/(?:momo-sandbox|momo-checkout(?:\/[^/]+)?)$/.exec(path)?.[1];
}

const RETURN_PREFIX = '/api/v1/qr-payments/payment-return/';
/** Unauthenticated page MoMo sends the browser to; it only bounces into the Wolfari app. */
export function paymentReturnRoute(path: string): string | undefined {
  return path.startsWith(RETURN_PREFIX) ? path.slice(RETURN_PREFIX.length) : undefined;
}
/** App links the bounce may open: Expo Go during development, or the Wolfari app scheme. */
export function paymentAppReturn(token: string): URL | undefined {
  if (!/^[A-Za-z0-9_-]{8,700}$/.test(token)) return undefined;
  let target: URL;
  try {
    target = new URL(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    !['exp:', 'exps:', 'wolfarimobile:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !/(?:^|\/)payment-return$/.test(`${target.host}${target.pathname}`)
  )
    return undefined;
  return target;
}

export function handlePaymentReturn(request: IncomingMessage, response: ServerResponse, url: URL, token: string) {
  if (request.method !== 'GET') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const target = paymentAppReturn(token);
  const order = url.searchParams.get('orderId') ?? '';
  if (!target || !/^\d{6}_w[a-f0-9]{24}$/.test(order)) return fail(response, 400, 'VALIDATION_FAILED');
  // The status here is unsigned and only a hint; the app asks Finance for the real result.
  target.searchParams.set('order_id', order);
  response.writeHead(302, { location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  response.end();
}

type Wallet = 'MOMO_CHECKOUT';
const walletPaymentUrl = (wallet: Wallet, value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const link = new URL(value);
  const host = wallet === 'MOMO_CHECKOUT' && link.hostname === 'test-payment.momo.vn';
  return link.protocol === 'https:' && host && !link.username && !link.password && !link.port ? link : undefined;
};

export async function handleQrPayment(
  request: IncomingMessage & { body?: unknown },
  response: ServerResponse,
  url: URL,
  tripId: string,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  const checkout = /\/qr-payments\/momo-checkout(?:\/([^/]+))?$/.exec(url.pathname);
  const wallet: Wallet = 'MOMO_CHECKOUT';
  if (checkout?.[1] !== undefined)
    return walletStatus(request, response, url, tripId, checkout[1], validateSession, client);
  if (request.method !== 'POST') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const auth = await authenticate(request, response, validateSession, true);
  if (!auth) return;
  try {
    ensureQuery(url, []);
    if (!uuid.test(tripId)) throw new RequestError('Invalid trip');
    const body = await requestBody(request);
    if (checkout) return await walletCreate(response, request, body, tripId, auth, client, wallet);
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

type Auth = NonNullable<Awaited<ReturnType<typeof authenticate>>>;

async function walletCreate(
  response: ServerResponse,
  request: IncomingMessage,
  body: Record<string, unknown>,
  tripId: string,
  auth: Auth,
  client: Pick<FinanceClient, 'call'>,
  wallet: Wallet,
) {
  onlyKeys(body, ['request_id', 'amount', 'note', 'redirect_url']);
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
    /[\u0000-\u001f\u007f]/.test(body.note) ||
    typeof body.redirect_url !== 'string' ||
    body.redirect_url.length > 1000
  )
    throw new RequestError('Invalid sandbox checkout');
  const redirect = new URL(body.redirect_url);
  const token = paymentReturnRoute(redirect.pathname);
  if (!['http:', 'https:'].includes(redirect.protocol) || redirect.search || !token || !paymentAppReturn(token))
    throw new RequestError('Invalid return page');
  const result = responseRecord(
    await client.call(
      'CreateQrSandboxPayment',
      {
        actor_user_id: auth.actorUserId,
        trip_id: tripId.toLowerCase(),
        request_id: body.request_id,
        amount: body.amount,
        note: body.note,
        provider: wallet,
        redirect_url: redirect.href,
      },
      auth.correlationId,
    ),
  );
  const link = walletPaymentUrl(wallet, result.payment_url);
  if (
    result.request_id !== body.request_id ||
    result.amount !== body.amount ||
    result.environment !== 'SANDBOX' ||
    typeof result.order_id !== 'string' ||
    !/^\d{6}_w[a-f0-9]{24}$/.test(result.order_id) ||
    !link
  )
    throw new Error('Invalid sandbox response');
  return json(response, 201, {
    data: { request_id: result.request_id, order_id: result.order_id, amount: result.amount, payment_url: link.href, environment: 'SANDBOX' },
    meta: { correlation_id: auth.correlationId },
  });
}

async function walletStatus(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  tripId: string,
  orderId: string,
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  if (request.method !== 'GET') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const auth = await authenticate(request, response, validateSession, false);
  if (!auth) return;
  try {
    ensureQuery(url, []);
    if (!uuid.test(tripId) || !/^\d{6}_w[a-f0-9]{24}$/.test(orderId)) throw new RequestError('Invalid order');
    const result = responseRecord(
      await client.call(
        'GetQrSandboxPayment',
        { actor_user_id: auth.actorUserId, trip_id: tripId.toLowerCase(), order_id: orderId },
        auth.correlationId,
      ),
    );
    if (
      result.order_id !== orderId ||
      !['PAID', 'PENDING', 'FAILED'].includes(String(result.status)) ||
      typeof result.amount !== 'string' ||
      result.environment !== 'SANDBOX'
    )
      throw new Error('Invalid sandbox response');
    return json(response, 200, {
      data: {
        order_id: orderId,
        status: result.status,
        amount: result.amount,
        provider_transaction_id: typeof result.provider_transaction_id === 'string' && /^\d{1,40}$/.test(result.provider_transaction_id) ? result.provider_transaction_id : null,
        environment: 'SANDBOX',
      },
      meta: { correlation_id: auth.correlationId },
    });
  } catch (cause) {
    if (cause instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, cause, false);
  }
}
