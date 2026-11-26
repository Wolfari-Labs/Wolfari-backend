import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { currentCorrelationId, PAYOS_RETURN_PATH, payosReturnTarget } from '@wolfari/common';
import type { FinanceClient } from './finance-client';
import { allowWebhookRequest, rawBody } from './bank-webhook-http';
import { domainFailure, ensureQuery, RequestError } from './trip-http';

type Request = IncomingMessage & { originalUrl?: string; body?: unknown };
export const PAYOS_WEBHOOK_PATH = '/api/v1/webhooks/payos';

function reply(response: ServerResponse, status: number, body: Record<string, unknown>) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

/**
 * payOS posts `{code, desc, success, data, signature}` and treats any 2xx as delivered. Finance
 * verifies the checksum signature over `data`; an unsigned or forged body is acknowledged without
 * being stored (so the confirm-webhook probe and probes from strangers end quietly), while a
 * Finance outage answers 503 so payOS delivers the real payment again.
 */
export async function handlePayosWebhook(
  request: Request,
  response: ServerResponse,
  url: URL,
  client: Pick<FinanceClient, 'call'>,
) {
  if (request.method !== 'POST') return reply(response, 404, { success: false });
  const source = String(request.socket?.remoteAddress ?? 'unknown');
  if (!allowWebhookRequest(`payos:${source}`)) return reply(response, 429, { success: false });
  let body: string;
  try {
    ensureQuery(url, []);
    body = (await rawBody(request)).toString('utf8');
    JSON.parse(body);
  } catch (error) {
    if (error instanceof RequestError || error instanceof SyntaxError)
      return reply(response, 400, { success: false });
    throw error;
  }
  try {
    await client.call('ReceivePayosWebhook', { body }, currentCorrelationId() ?? randomUUID());
    return reply(response, 200, { success: true });
  } catch (error) {
    const code = domainFailure(error)?.code;
    if (code === 'PERMISSION_DENIED' || code === 'VALIDATION_FAILED')
      return reply(response, 200, { success: true });
    return reply(response, 503, { success: false });
  }
}

const STATUSES = new Set(['PAID', 'PENDING', 'PROCESSING', 'CANCELLED', 'EXPIRED', 'FAILED', 'UNDERPAID']);
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * Where payOS sends the payer's browser after paying or cancelling. The path token is the app
 * link chosen when the attempt was created; it is validated again here and only app schemes
 * (Expo Go, the Wolfari build) are ever opened, so this page is not an open redirect. The page
 * itself proves nothing: the app reads the attempt from the API, which only the webhook settles.
 */
export function handlePayosReturn(request: Request, response: ServerResponse, url: URL) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 404;
    return response.end();
  }
  // An app deep link (mobile) or a page on WEB_ORIGIN (web); any other website is refused.
  const app = payosReturnTarget(
    url.pathname.slice(PAYOS_RETURN_PATH.length),
    process.env.WEB_ORIGIN,
  );
  if (!app) {
    response.statusCode = 400;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return response.end('Liên kết quay lại không hợp lệ.');
  }
  const status = url.searchParams.get('status') ?? '';
  const orderCode = url.searchParams.get('orderCode') ?? '';
  const cancelled = url.searchParams.get('cancel') === 'true';
  const target = new URL(app);
  target.searchParams.set('provider', 'PAYOS');
  target.searchParams.set('status', cancelled ? 'CANCELLED' : STATUSES.has(status) ? status : 'UNKNOWN');
  if (/^\d{1,16}$/.test(orderCode)) target.searchParams.set('orderCode', orderCode);
  const href = escapeHtml(target.href);
  // Mobile browsers often refuse to leave for an app scheme without a tap, so the page tries a
  // refresh and always offers the button; switching back to the app by hand works the same.
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  return response.end(
    `<!doctype html><html lang="vi"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta http-equiv="refresh" content="0;url=${href}"><title>Wolfari</title></head>` +
      `<body style="font-family:system-ui;padding:24px;text-align:center">` +
      `<p>${cancelled ? 'Bạn đã hủy thanh toán.' : 'Đã nhận kết quả từ payOS.'}</p>` +
      `<p>Wolfari chỉ xác nhận khoản góp khi ngân hàng báo tiền đã về.</p>` +
      `<p><a href="${href}" style="display:inline-block;padding:14px 22px;border-radius:12px;background:#1f6feb;color:#fff;text-decoration:none">Quay lại Wolfari</a></p>` +
      `</body></html>`,
  );
}
