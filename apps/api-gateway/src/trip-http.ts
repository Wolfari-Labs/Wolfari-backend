import { status, type ServiceError } from '@grpc/grpc-js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { currentCorrelationId } from '@wolfari/common';

export type RpcMessage = Record<string, unknown>;

export type Session = { user_id?: string; system_role?: number };

export type SessionValidator = (accessToken: string, correlationId: string) => Promise<Session>;

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const rfc3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

export class RequestError extends Error {}

export function isLoopbackGrpcTarget(value: string): boolean {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function record(value: unknown): RpcMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new RequestError('Expected an object');
  return value as RpcMessage;
}

export function responseRecord(value: unknown): RpcMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid Trip response');
  return value as RpcMessage;
}

export function onlyKeys(value: RpcMessage, allowed: readonly string[]) {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new RequestError('Unknown field');
}

export function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Trip response');
  return value;
}

export function requiredInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error('Invalid Trip response');
  return Number(value);
}

export function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value);
}

export function enumValue(value: unknown, names: Record<number, string>): string {
  if (typeof value === 'string') {
    const suffix = Object.values(names).find(
      (name) => value === name || value.endsWith(`_${name}`),
    );
    if (suffix) return suffix;
  }
  const name = names[Number(value)];
  if (!name) throw new Error('Invalid Trip response');
  return name;
}

export function timestampToIso(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid Trip response');
    return parsed.toISOString();
  }
  const timestamp = responseRecord(value);
  const seconds = timestamp.seconds;
  const nanos = timestamp.nanos ?? 0;
  if (
    (typeof seconds !== 'string' && typeof seconds !== 'number') ||
    !Number.isInteger(Number(nanos))
  )
    throw new Error('Invalid Trip response');
  try {
    const milliseconds = Number(
      BigInt(seconds) * 1000n + BigInt(Math.trunc(Number(nanos) / 1_000_000)),
    );
    const parsed = new Date(milliseconds);
    if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid Trip response');
    return parsed.toISOString();
  } catch {
    throw new Error('Invalid Trip response');
  }
}

export function json(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

export function fail(
  response: ServerResponse,
  statusCode: number,
  code: string,
  options: { details?: Record<string, number> | null; retryable?: boolean; write?: boolean } = {},
) {
  const message =
    statusCode === 503 && options.write
      ? 'Dịch vụ tạm thời không khả dụng; thử lại thao tác với cùng khóa chống lặp'
      : 'Không thể hoàn tất yêu cầu';
  json(response, statusCode, {
    error: {
      code,
      message,
      details: options.details ?? null,
      retryable: options.retryable ?? false,
    },
    meta: { correlation_id: currentCorrelationId() },
  });
}

export function domainFailure(
  cause: unknown,
): { code: string; details: Record<string, number> | null } | null {
  const raw = (cause as Partial<ServiceError>).details;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = responseRecord(JSON.parse(raw));
    if (typeof parsed.code !== 'string') return null;
    const details =
      parsed.details === null || parsed.details === undefined
        ? null
        : responseRecord(parsed.details);
    const revisions: Record<string, number> = {};
    if (details) {
      for (const key of [
        'plan_version',
        'membership_revision',
        'export_revision',
        'invitation_version',
      ] as const) {
        const value = details[key];
        if (Number.isSafeInteger(value) && Number(value) >= 1) revisions[key] = Number(value);
      }
    }
    return { code: parsed.code, details: Object.keys(revisions).length ? revisions : null };
  } catch {
    return null;
  }
}

export function grpcFailure(response: ServerResponse, cause: unknown, write: boolean) {
  const error = cause as Partial<ServiceError>;
  const domain = domainFailure(cause);
  if (domain?.code === 'VALIDATION_FAILED') return fail(response, 400, 'VALIDATION_FAILED');
  if (domain?.code === 'UNAUTHENTICATED') return fail(response, 401, 'UNAUTHENTICATED');
  if (domain?.code === 'PERMISSION_DENIED') return fail(response, 403, 'PERMISSION_DENIED');
  if (domain?.code === 'RESOURCE_NOT_FOUND') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  if (domain?.code === 'IDEMPOTENCY_CONFLICT') return fail(response, 409, 'IDEMPOTENCY_CONFLICT');
  if (domain?.code === 'VERSION_CONFLICT')
    return fail(response, 409, 'VERSION_CONFLICT', { details: domain.details });
  if (domain?.code === 'STATE_CONFLICT') return fail(response, 409, 'STATE_CONFLICT');
  if (error.code === status.INVALID_ARGUMENT) return fail(response, 400, 'VALIDATION_FAILED');
  if (error.code === status.UNAUTHENTICATED) return fail(response, 401, 'UNAUTHENTICATED');
  if (error.code === status.NOT_FOUND) return fail(response, 404, 'RESOURCE_NOT_FOUND');
  return fail(response, 503, 'SERVICE_UNAVAILABLE', { retryable: true, write });
}

export function parseTimestamp(value: unknown): { seconds: string; nanos: number } {
  if (typeof value !== 'string') throw new RequestError('Invalid timestamp');
  const match = rfc3339.exec(value);
  if (!match) throw new RequestError('Invalid timestamp');
  const [, year, month, day, hour, minute, second, fraction = '', offset] = match;
  const values = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, sec] = values as [number, number, number, number, number, number];
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== m - 1 ||
    calendar.getUTCDate() !== d ||
    h > 23 ||
    min > 59 ||
    sec > 59
  ) {
    throw new RequestError('Invalid timestamp');
  }
  if (offset !== 'Z') {
    const [offsetHour, offsetMinute] = offset.slice(1).split(':').map(Number);
    if (offsetHour! > 23 || offsetMinute! > 59) throw new RequestError('Invalid timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RequestError('Invalid timestamp');
  return {
    seconds: String(Math.floor(milliseconds / 1000)),
    nanos: Number(fraction.padEnd(9, '0')),
  };
}

export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function idempotencyKey(request: IncomingMessage, required: boolean): string | undefined {
  const value = request.headers['idempotency-key'];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !uuid.test(value))
    throw new RequestError('Invalid Idempotency-Key');
  return value.toLowerCase();
}

export async function requestBody(request: IncomingMessage): Promise<RpcMessage> {
  const mediaType = String(request.headers['content-type'] ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
  if (mediaType !== 'application/json') throw new RequestError('Expected application/json');
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined) {
    if (Buffer.byteLength(JSON.stringify(parsed)) > 1024 * 1024)
      throw new RequestError('Body too large');
    return record(parsed);
  }
  const pieces: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const piece = Buffer.from(chunk as Buffer);
    total += piece.length;
    if (total > 1024 * 1024) throw new RequestError('Body too large');
    pieces.push(piece);
  }
  if (total === 0) throw new RequestError('Missing body');
  try {
    return record(JSON.parse(Buffer.concat(pieces).toString('utf8')));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('Invalid JSON');
  }
}

export function ensureQuery(url: URL, allowed: readonly string[]) {
  const accepted = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!accepted.has(key) || url.searchParams.getAll(key).length !== 1)
      throw new RequestError('Invalid query');
  }
}

export async function authenticate(
  request: IncomingMessage,
  response: ServerResponse,
  validateSession: SessionValidator,
  write: boolean,
): Promise<{ actorUserId: string; correlationId: string } | null> {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
  if (!bearer) {
    fail(response, 401, 'UNAUTHENTICATED');
    return null;
  }
  const correlationId = currentCorrelationId();
  if (!correlationId) {
    fail(response, 503, 'SERVICE_UNAVAILABLE', { retryable: true, write });
    return null;
  }
  let actorUserId: string;
  try {
    const session = await validateSession(bearer[1]!, correlationId);
    if (typeof session.user_id !== 'string' || !uuid.test(session.user_id))
      throw new Error('Invalid Identity response');
    actorUserId = session.user_id.toLowerCase();
  } catch (cause) {
    const code = (cause as { code?: number }).code;
    if (code === status.UNAUTHENTICATED) {
      fail(response, 401, 'UNAUTHENTICATED');
      return null;
    }
    fail(response, 503, 'SERVICE_UNAVAILABLE', {
      retryable: true,
      write,
    });
    return null;
  }

  return { actorUserId, correlationId };
}
