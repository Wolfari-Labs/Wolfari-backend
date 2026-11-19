import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { currentCorrelationId } from '@wolfari/common';
import { randomUUID } from 'node:crypto';
import type { FinanceClient } from './finance-client';
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
export type BankRoute =
  | { kind: 'webhook'; provider: 'sepay' }
  | { kind: 'list'; fundId: string }
  | { kind: 'resolve'; fundId: string; transferId: string };

export function bankRoute(path: string): BankRoute | undefined {
  if (path === '/api/v1/webhooks/bank/sepay') return { kind: 'webhook', provider: 'sepay' };
  const list = /^\/api\/v1\/funds\/([^/]+)\/bank-transfers$/.exec(path);
  if (list) return { kind: 'list', fundId: list[1]! };
  const resolve = /^\/api\/v1\/funds\/([^/]+)\/bank-transfers\/([^/]+)\/resolve$/.exec(path);
  return resolve ? { kind: 'resolve', fundId: resolve[1]!, transferId: resolve[2]! } : undefined;
}

const MAX_BODY = 64 * 1024;
const SIGNATURE_WINDOW_SECONDS = 300;
const RATE_LIMIT_PER_MINUTE = 60;

/** Per-source token bucket; a webhook endpoint is unauthenticated until the signature checks out. */
const buckets = new Map<string, { tokens: number; refilledAt: number }>();
export function allowWebhookRequest(source: string, now = Date.now()): boolean {
  const bucket = buckets.get(source) ?? { tokens: RATE_LIMIT_PER_MINUTE, refilledAt: now };
  const refill = ((now - bucket.refilledAt) / 60_000) * RATE_LIMIT_PER_MINUTE;
  bucket.tokens = Math.min(RATE_LIMIT_PER_MINUTE, bucket.tokens + refill);
  bucket.refilledAt = now;
  if (buckets.size > 10_000) buckets.clear();
  buckets.set(source, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

export type SepayConfig = { secret?: string; apiKey?: string };
export function sepayConfig(env: NodeJS.ProcessEnv = process.env): SepayConfig {
  const secret = env.BANK_WEBHOOK_SEPAY_SECRET?.trim();
  const apiKey = env.BANK_WEBHOOK_SEPAY_API_KEY?.trim();
  return {
    ...(secret && secret.length >= 16 ? { secret } : {}),
    ...(apiKey && apiKey.length >= 16 ? { apiKey } : {}),
  };
}

class WebhookAuthError extends Error {}

/**
 * SePay signs `${timestamp}.${rawBody}` with HMAC-SHA256 (`X-Sepay-Signature: sha256=<hex>`,
 * `X-Sepay-Timestamp: <unix seconds>`); the API-key mode sends `Authorization: Apikey <key>`.
 * Comparison is constant-time and the timestamp must be within five minutes.
 */
export function verifySepay(
  headers: IncomingMessage['headers'],
  rawBody: Buffer,
  config: SepayConfig,
  now = Date.now(),
): 'hmac' | 'apikey' {
  const signature = headers['x-sepay-signature'];
  const timestamp = headers['x-sepay-timestamp'];
  if (config.secret && typeof signature === 'string' && typeof timestamp === 'string') {
    if (!/^\d{1,13}$/.test(timestamp)) throw new WebhookAuthError('Request expired');
    if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS)
      throw new WebhookAuthError('Request expired');
    const expected = Buffer.from(
      `sha256=${createHmac('sha256', config.secret)
        .update(timestamp + '.')
        .update(rawBody)
        .digest('hex')}`,
    );
    const provided = Buffer.from(signature.trim());
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
      throw new WebhookAuthError('Invalid signature');
    return 'hmac';
  }
  const authorization = headers.authorization;
  if (config.apiKey && typeof authorization === 'string') {
    const match = /^Apikey\s+(\S+)$/i.exec(authorization.trim());
    const provided = Buffer.from(match?.[1] ?? '');
    const expected = Buffer.from(config.apiKey);
    if (!match || provided.length !== expected.length || !timingSafeEqual(provided, expected))
      throw new WebhookAuthError('Invalid signature');
    return 'apikey';
  }
  throw new WebhookAuthError('Invalid signature');
}

async function rawBody(request: Request): Promise<Buffer> {
  if (request.body !== undefined) throw new Error('Webhook body was parsed before signing');
  const pieces: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const piece = Buffer.from(chunk as Buffer);
    total += piece.length;
    if (total > MAX_BODY) throw new RequestError('Body too large');
    pieces.push(piece);
  }
  if (total === 0) throw new RequestError('Empty body');
  return Buffer.concat(pieces);
}

const digits = (value: unknown, max: number) => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text) || text.length > max)
    throw new RequestError('Invalid payload');
  return text;
};
const optionalText = (value: unknown, max: number) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.includes('\u0000') || [...value].length > max)
    throw new RequestError('Invalid payload');
  return value;
};

/** Field names follow SePay's webhook payload; unknown keys are ignored so provider additions cannot break delivery. */
export function parseSepayPayload(raw: Buffer) {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new RequestError('Invalid payload');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new RequestError('Invalid payload');
  const r = body as Record<string, unknown>;
  const transferType =
    r.transferType === 'in' ? 'IN' : r.transferType === 'out' ? 'OUT' : undefined;
  if (!transferType) throw new RequestError('Invalid payload');
  const amount = digits(r.transferAmount, 19);
  if (amount === '0' || amount.replace(/^0+/, '').length > 19)
    throw new RequestError('Invalid payload');
  return {
    provider: 'SEPAY',
    provider_transaction_id: digits(r.id, 40),
    transfer_type: transferType,
    amount: amount.replace(/^0+(?=\d)/, ''),
    content: optionalText(r.content, 2000),
    account_number: optionalText(r.accountNumber, 80),
    bank_gateway: optionalText(r.gateway, 80),
    reference_code: optionalText(r.referenceCode, 150),
    sub_account: optionalText(r.subAccount, 80),
    transaction_date: optionalText(r.transactionDate, 40),
    payload_json: raw.toString('utf8'),
  };
}

function reply(response: ServerResponse, status: number, body: Record<string, unknown>) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

export async function handleBankWebhook(
  request: Request,
  response: ServerResponse,
  url: URL,
  client: Pick<FinanceClient, 'call'>,
  config: SepayConfig = sepayConfig(),
) {
  if (request.method !== 'POST') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const source = String(request.socket?.remoteAddress ?? 'unknown');
  if (!allowWebhookRequest(source))
    return reply(response, 429, { success: false, message: 'Too many requests' });
  if (!config.secret && !config.apiKey)
    return reply(response, 503, { success: false, message: 'Webhook not configured' });
  try {
    ensureQuery(url, []);
    const raw = await rawBody(request);
    verifySepay(request.headers, raw, config);
    const payload = parseSepayPayload(raw);
    const result = responseRecord(
      await client.call('ReceiveBankTransfer', payload, currentCorrelationId() ?? randomUUID()),
    );
    return reply(response, 200, {
      success: true,
      receipt_id: requiredString(result.receipt_id),
      status: requiredString(result.processing_status),
    });
  } catch (error) {
    if (error instanceof WebhookAuthError)
      return reply(response, 401, { success: false, message: error.message });
    if (error instanceof RequestError)
      return reply(response, 400, { success: false, message: 'Invalid payload' });
    response.setHeader('Cache-Control', 'no-store');
    return grpcFailure(response, error, true);
  }
}

const time = (value: unknown) =>
  value === undefined || value === null ? null : timestampToIso(value);
export function projectBankTransfer(value: unknown) {
  const row = responseRecord(value);
  if (!['MATCHED', 'UNMATCHED', 'NEEDS_REVIEW', 'IGNORED', 'RESOLVED'].includes(String(row.processing_status)))
    throw new Error('Invalid bank transfer');
  const id = requiredString(row.id);
  if (!uuid.test(id)) throw new Error('Invalid bank transfer');
  const amount = requiredString(row.amount);
  if (!/^[1-9]\d{0,18}$/.test(amount)) throw new Error('Invalid bank transfer amount');
  const transferType = String(row.transfer_type);
  if (!['IN', 'OUT'].includes(transferType)) throw new Error('Invalid bank transfer');
  const contribution =
    row.contribution_id === undefined ? null : requiredString(row.contribution_id);
  if (contribution && !uuid.test(contribution)) throw new Error('Invalid bank transfer');
  return {
    id: id.toLowerCase(),
    provider: requiredString(row.provider),
    provider_transaction_id: requiredString(row.provider_transaction_id),
    transfer_type: transferType,
    amount,
    content: requiredString(row.content),
    account_number_masked: requiredString(row.account_number_masked),
    bank_gateway: row.bank_gateway === undefined ? '' : requiredString(row.bank_gateway),
    processing_status: String(row.processing_status),
    contribution_id: contribution?.toLowerCase() ?? null,
    review_reason: row.review_reason === undefined ? null : requiredString(row.review_reason),
    transaction_at: time(row.transaction_at),
    received_at: timestampToIso(row.received_at),
    processed_at: time(row.processed_at),
    ...resolutionFields(row),
  };
}

export const BANK_TRANSFER_RESOLUTIONS = ['RETURNED_TO_SENDER', 'HANDLED_IN_APP', 'NOT_OURS'] as const;
/** Resolution columns appear only, and always all together, on a RESOLVED transfer. */
function resolutionFields(row: Record<string, unknown>) {
  const resolved = row.processing_status === 'RESOLVED';
  const present = [row.resolution, row.resolution_note, row.resolved_by_user_id, row.resolved_at].map(
    (value) => value !== undefined && value !== null && value !== '',
  );
  if (present.some((value) => value !== resolved)) throw new Error('Invalid bank transfer resolution');
  if (!resolved)
    return { resolution: null, resolution_note: null, resolved_by_user_id: null, resolved_at: null };
  const resolution = requiredString(row.resolution);
  if (!(BANK_TRANSFER_RESOLUTIONS as readonly string[]).includes(resolution))
    throw new Error('Invalid bank transfer resolution');
  const resolver = requiredString(row.resolved_by_user_id);
  if (!uuid.test(resolver)) throw new Error('Invalid bank transfer resolution');
  return {
    resolution,
    resolution_note: requiredString(row.resolution_note),
    resolved_by_user_id: resolver.toLowerCase(),
    resolved_at: timestampToIso(row.resolved_at),
  };
}

/** Holder marks a NEEDS_REVIEW transfer handled; the Idempotency-Key makes a retry return the same result. */
export async function handleBankTransferResolve(
  request: Request,
  response: ServerResponse,
  url: URL,
  route: { fundId: string; transferId: string },
  validateSession: SessionValidator,
  client: Pick<FinanceClient, 'call'>,
) {
  if (request.method !== 'POST') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const auth = await authenticate(request, response, validateSession, true);
  if (!auth) return;
  try {
    ensureQuery(url, []);
    if (!uuid.test(route.fundId) || !uuid.test(route.transferId))
      throw new RequestError('Invalid bank transfer scope');
    const operationId = idempotencyKey(request, true);
    const body = await requestBody(request);
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new RequestError('Invalid body');
    const input = body as Record<string, unknown>;
    onlyKeys(input, ['resolution', 'note', 'expected_finance_version']);
    if (!(BANK_TRANSFER_RESOLUTIONS as readonly string[]).includes(String(input.resolution)))
      throw new RequestError('Invalid resolution');
    if (
      typeof input.note !== 'string' ||
      !input.note.trim() ||
      input.note.includes('\u0000') ||
      [...input.note].length > 500
    )
      throw new RequestError('Invalid note');
    const version = input.expected_finance_version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 2147483647)
      throw new RequestError('Invalid version');
    const result = await client.call(
      'ResolveBankTransfer',
      {
        operation_id: operationId,
        actor_user_id: auth.actorUserId,
        fund_id: route.fundId.toLowerCase(),
        bank_transfer_id: route.transferId.toLowerCase(),
        resolution: input.resolution,
        note: input.note,
        expected_finance_version: version,
      },
      auth.correlationId,
    );
    const transfer = projectBankTransfer(result.bank_transfer);
    if (transfer.id !== route.transferId.toLowerCase() || transfer.processing_status !== 'RESOLVED')
      throw new Error('Bank transfer result mismatch');
    // finance_version moved; clients reload the Fund after the write like every other command.
    requiredInteger(result.finance_version);
    return json(response, 200, { data: transfer, meta: { correlation_id: auth.correlationId } });
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, true);
  }
}

export async function handleBankTransfers(
  request: Request,
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
    ensureQuery(url, []);
    if (!uuid.test(fundId)) throw new RequestError('Invalid Fund ID');
    const result = await client.call(
      'ListBankTransfers',
      { actor_user_id: auth.actorUserId, fund_id: fundId.toLowerCase() },
      auth.correlationId,
    );
    // proto-loader omits an empty repeated field (arrays: false): missing means no rows.
    const rawItems = result.items ?? [];
    if (!Array.isArray(rawItems)) throw new Error('Invalid bank transfer list');
    return json(response, 200, {
      data: { items: rawItems.map(projectBankTransfer) },
      meta: { correlation_id: auth.correlationId },
    });
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    return grpcFailure(response, error, false);
  }
}
