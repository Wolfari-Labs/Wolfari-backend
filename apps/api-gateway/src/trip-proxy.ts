import { status, type ServiceError } from '@grpc/grpc-js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { currentCorrelationId } from '@wolfari/common';
import { TripClient } from './trip-client';

type RpcMessage = Record<string, unknown>;
type Session = { user_id?: string; system_role?: number };
type SessionValidator = (accessToken: string, correlationId: string) => Promise<Session>;
type Route = 'create' | 'list' | 'get' | 'update' | 'planPolicy';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rfc3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const lifecycleValues: Record<string, number> = {
  UPCOMING: 1,
  ONGOING: 2,
  COMPLETED: 3,
  ARCHIVED: 4,
};
const lifecycleNames: Record<number, string> = {
  1: 'UPCOMING',
  2: 'ONGOING',
  3: 'COMPLETED',
  4: 'ARCHIVED',
};
const membershipRoles: Record<number, string> = { 1: 'OWNER', 2: 'MEMBER' };
const planPolicies: Record<number, string> = {
  1: 'OWNER_ONLY',
  2: 'SELECTED_MEMBERS',
  3: 'ALL_MEMBERS',
};
const planPolicyValues: Record<string, number> = {
  OWNER_ONLY: 1,
  SELECTED_MEMBERS: 2,
  ALL_MEMBERS: 3,
};

class RequestError extends Error {}

function isLoopbackGrpcTarget(value: string): boolean {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function record(value: unknown): RpcMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new RequestError('Expected an object');
  return value as RpcMessage;
}

function responseRecord(value: unknown): RpcMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid Trip response');
  return value as RpcMessage;
}

function onlyKeys(value: RpcMessage, allowed: readonly string[]) {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new RequestError('Unknown field');
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Trip response');
  return value;
}

function requiredInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error('Invalid Trip response');
  return Number(value);
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value);
}

function enumValue(value: unknown, names: Record<number, string>): string {
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

function timestampToIso(value: unknown): string {
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

function projectMembership(value: unknown) {
  const membership = responseRecord(value);
  return {
    id: requiredString(membership.id),
    trip_id: requiredString(membership.trip_id),
    user_id: requiredString(membership.user_id),
    role: enumValue(membership.role, membershipRoles),
    joined_at: timestampToIso(membership.joined_at),
    left_at:
      membership.left_at === undefined || membership.left_at === null
        ? null
        : timestampToIso(membership.left_at),
  };
}

function projectTrip(value: unknown) {
  const trip = responseRecord(value);
  const permissions = responseRecord(trip.permissions);
  if (
    typeof permissions.can_read !== 'boolean' ||
    typeof permissions.can_update !== 'boolean' ||
    !permissions.can_read
  ) {
    throw new Error('Invalid Trip response');
  }
  return {
    id: requiredString(trip.id),
    name: requiredString(trip.name),
    description: optionalString(trip.description),
    start_at: timestampToIso(trip.start_at),
    end_at: timestampToIso(trip.end_at),
    timezone: requiredString(trip.timezone),
    lifecycle: enumValue(trip.lifecycle, lifecycleNames),
    archived_at:
      trip.archived_at === undefined || trip.archived_at === null
        ? null
        : timestampToIso(trip.archived_at),
    public_description: optionalString(trip.public_description),
    plan_edit_policy: enumValue(trip.plan_edit_policy, planPolicies),
    plan_version: requiredInteger(trip.plan_version),
    membership_revision: requiredInteger(trip.membership_revision),
    export_revision: requiredInteger(trip.export_revision),
    current_membership: projectMembership(trip.current_membership),
    permissions: { can_read: permissions.can_read, can_update: permissions.can_update },
  };
}

function projectPlanPolicy(value: unknown) {
  const planPolicy = responseRecord(value);
  if (planPolicy.editor_member_ids !== undefined && !Array.isArray(planPolicy.editor_member_ids)) {
    throw new Error('Invalid Trip response');
  }
  const editorMemberIds = (planPolicy.editor_member_ids ?? []).map(requiredString);
  if (new Set(editorMemberIds).size !== editorMemberIds.length) {
    throw new Error('Invalid Trip response');
  }
  return {
    policy: enumValue(planPolicy.policy, planPolicies),
    editor_member_ids: editorMemberIds,
    membership_revision: requiredInteger(planPolicy.membership_revision),
  };
}

function json(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

function fail(
  response: ServerResponse,
  statusCode: number,
  code: string,
  options: { details?: Record<string, number> | null; retryable?: boolean; write?: boolean } = {},
) {
  const message =
    statusCode === 503 && options.write
      ? 'Service temporarily unavailable; retry this write with the same idempotency key'
      : 'Request could not be completed';
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

function domainFailure(
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
      for (const key of ['plan_version', 'membership_revision', 'export_revision'] as const) {
        const value = details[key];
        if (Number.isSafeInteger(value) && Number(value) >= 1) revisions[key] = Number(value);
      }
    }
    return { code: parsed.code, details: Object.keys(revisions).length ? revisions : null };
  } catch {
    return null;
  }
}

function grpcFailure(response: ServerResponse, cause: unknown, write: boolean) {
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

function parseTimestamp(value: unknown): { seconds: string; nanos: number } {
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

function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function idempotencyKey(request: IncomingMessage, required: boolean): string | undefined {
  const value = request.headers['idempotency-key'];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !uuid.test(value))
    throw new RequestError('Invalid Idempotency-Key');
  return value.toLowerCase();
}

async function requestBody(request: IncomingMessage): Promise<RpcMessage> {
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

function routeFor(method: string, pathname: string): { route: Route; tripId?: string } | null {
  if (pathname === '/api/v1/trips') {
    if (method === 'POST') return { route: 'create' };
    if (method === 'GET') return { route: 'list' };
    return null;
  }
  const planPolicyMatch = /^\/api\/v1\/trips\/([^/]+)\/plan-policy$/.exec(pathname);
  if (planPolicyMatch) {
    if (method !== 'PUT') return null;
    if (!uuid.test(planPolicyMatch[1]!)) throw new RequestError('Invalid trip id');
    return { route: 'planPolicy', tripId: planPolicyMatch[1]!.toLowerCase() };
  }
  const match = /^\/api\/v1\/trips\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  if (method !== 'GET' && method !== 'PATCH') return null;
  if (!uuid.test(match[1]!)) throw new RequestError('Invalid trip id');
  return { route: method === 'GET' ? 'get' : 'update', tripId: match[1]!.toLowerCase() };
}

function planPolicyRequest(
  body: RpcMessage,
  actorUserId: string,
  tripId: string,
  operationId: string,
): RpcMessage {
  onlyKeys(body, ['policy', 'editor_member_ids', 'expected_membership_revision']);
  if (!Object.hasOwn(body, 'policy') || !Object.hasOwn(body, 'editor_member_ids')) {
    throw new RequestError('Missing plan policy fields');
  }
  if (!Object.hasOwn(body, 'expected_membership_revision')) {
    throw new RequestError('Missing membership revision');
  }
  const policy = body.policy;
  if (typeof policy !== 'string' || planPolicyValues[policy] === undefined) {
    throw new RequestError('Invalid plan policy');
  }
  if (!Array.isArray(body.editor_member_ids)) throw new RequestError('Invalid editor list');
  const editorMemberIds = body.editor_member_ids.map((value) => {
    if (typeof value !== 'string' || !uuid.test(value)) {
      throw new RequestError('Invalid editor member id');
    }
    return value.toLowerCase();
  });
  if (new Set(editorMemberIds).size !== editorMemberIds.length) {
    throw new RequestError('Duplicate editor member id');
  }
  editorMemberIds.sort();
  if (policy !== 'SELECTED_MEMBERS' && editorMemberIds.length > 0) {
    throw new RequestError('Editor list requires SELECTED_MEMBERS');
  }
  if (
    !Number.isSafeInteger(body.expected_membership_revision) ||
    Number(body.expected_membership_revision) < 1 ||
    Number(body.expected_membership_revision) > 2_147_483_647
  ) {
    throw new RequestError('Invalid membership revision');
  }
  return {
    operation_id: operationId,
    actor_user_id: actorUserId,
    trip_id: tripId,
    policy: planPolicyValues[policy],
    editor_member_ids: editorMemberIds,
    expected_membership_revision: body.expected_membership_revision,
  };
}

function ensureQuery(url: URL, allowed: readonly string[]) {
  const accepted = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!accepted.has(key) || url.searchParams.getAll(key).length !== 1)
      throw new RequestError('Invalid query');
  }
}

function createRequest(body: RpcMessage, actorUserId: string, headerKey?: string): RpcMessage {
  onlyKeys(body, ['name', 'description', 'start_at', 'end_at', 'timezone', 'client_request_id']);
  if (typeof body.name !== 'string') throw new RequestError('Invalid name');
  const name = body.name.trim();
  if (name.length < 1 || name.length > 200) throw new RequestError('Invalid name');
  if (typeof body.client_request_id !== 'string' || !uuid.test(body.client_request_id))
    throw new RequestError('Invalid client_request_id');
  const operationId = body.client_request_id.toLowerCase();
  if (headerKey && headerKey !== operationId) throw new RequestError('Idempotency keys differ');
  if (body.description !== undefined && typeof body.description !== 'string')
    throw new RequestError('Invalid description');
  const timezone = body.timezone ?? 'Asia/Ho_Chi_Minh';
  if (!validTimezone(timezone)) throw new RequestError('Invalid timezone');
  const startAt = parseTimestamp(body.start_at);
  const endAt = parseTimestamp(body.end_at);
  if (
    BigInt(endAt.seconds) * 1_000_000_000n + BigInt(endAt.nanos) <=
    BigInt(startAt.seconds) * 1_000_000_000n + BigInt(startAt.nanos)
  ) {
    throw new RequestError('Invalid date range');
  }
  return {
    operation_id: operationId,
    actor_user_id: actorUserId,
    name,
    start_at: startAt,
    end_at: endAt,
    timezone,
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
  };
}

function updateRequest(
  body: RpcMessage,
  actorUserId: string,
  tripId: string,
  operationId: string,
): RpcMessage {
  onlyKeys(body, [
    'name',
    'description',
    'public_description',
    'expected_plan_version',
    'expected_export_revision',
  ]);
  const hasName = Object.hasOwn(body, 'name');
  const hasDescription = Object.hasOwn(body, 'description');
  const hasPublicDescription = Object.hasOwn(body, 'public_description');
  if (!hasName && !hasDescription && !hasPublicDescription)
    throw new RequestError('Missing update');
  if (
    !Number.isSafeInteger(body.expected_plan_version) ||
    Number(body.expected_plan_version) < 1 ||
    Number(body.expected_plan_version) > 2_147_483_647
  )
    throw new RequestError('Invalid plan revision');
  if (
    !Number.isSafeInteger(body.expected_export_revision) ||
    Number(body.expected_export_revision) < 1 ||
    Number(body.expected_export_revision) > 2_147_483_647
  )
    throw new RequestError('Invalid export revision');
  const request: RpcMessage = {
    operation_id: operationId,
    actor_user_id: actorUserId,
    trip_id: tripId,
    expected_plan_version: body.expected_plan_version,
    expected_export_revision: body.expected_export_revision,
  };
  if (hasName) {
    if (typeof body.name !== 'string') throw new RequestError('Invalid name');
    const name = body.name.trim();
    if (name.length < 1 || name.length > 200) throw new RequestError('Invalid name');
    request.name = name;
  }
  for (const field of ['description', 'public_description'] as const) {
    if (!Object.hasOwn(body, field)) continue;
    if (body[field] === null) request[field] = { clear: true };
    else if (typeof body[field] === 'string') request[field] = { value: body[field] };
    else throw new RequestError(`Invalid ${field}`);
  }
  return request;
}

export class TripProxy {
  private readonly client: TripClient;

  constructor(private readonly validateSession: SessionValidator) {
    const target = process.env.TRIP_GRPC_TARGET ?? '127.0.0.1:3202';
    const secret = process.env.GATEWAY_TRIP_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32)
      throw new Error('Gateway Trip configuration invalid');
    if (process.env.NODE_ENV === 'production')
      throw new Error('Gateway Trip transport requires TLS in production');
    this.client = new TripClient(target, secret);
  }

  matches(request: IncomingMessage & { originalUrl?: string }): boolean {
    try {
      return new URL(
        request.originalUrl ?? request.url ?? '/',
        'http://localhost',
      ).pathname.startsWith('/api/v1/trips');
    } catch {
      return false;
    }
  }

  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const method = request.method ?? '';
    let url: URL;
    let route: { route: Route; tripId?: string } | null;
    try {
      url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
      route = routeFor(method, url.pathname);
    } catch (error) {
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return fail(response, 404, 'RESOURCE_NOT_FOUND');
    }
    if (!route) return fail(response, 404, 'RESOURCE_NOT_FOUND');
    const write =
      route.route === 'create' || route.route === 'update' || route.route === 'planPolicy';

    const authorization = request.headers.authorization;
    const bearer =
      typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    if (!bearer) return fail(response, 401, 'UNAUTHENTICATED');
    const correlationId = currentCorrelationId();
    if (!correlationId)
      return fail(response, 503, 'SERVICE_UNAVAILABLE', {
        retryable: true,
        write,
      });
    let actorUserId: string;
    try {
      const session = await this.validateSession(bearer[1]!, correlationId);
      if (typeof session.user_id !== 'string' || !uuid.test(session.user_id))
        throw new Error('Invalid Identity response');
      actorUserId = session.user_id.toLowerCase();
    } catch (cause) {
      const code = (cause as { code?: number }).code;
      if (code === status.UNAUTHENTICATED) return fail(response, 401, 'UNAUTHENTICATED');
      return fail(response, 503, 'SERVICE_UNAVAILABLE', {
        retryable: true,
        write,
      });
    }

    try {
      let result: RpcMessage;
      if (route.route === 'create') {
        ensureQuery(url, []);
        const body = await requestBody(request);
        result = await this.client.createTrip(
          createRequest(body, actorUserId, idempotencyKey(request, false)),
          correlationId,
        );
        return json(response, 201, {
          data: projectTrip(result.trip),
          meta: { correlation_id: correlationId },
        });
      }
      if (route.route === 'list') {
        ensureQuery(url, ['limit', 'cursor', 'lifecycle']);
        const rawLimit = url.searchParams.get('limit');
        if (rawLimit !== null && !/^(?:[1-9]|[1-9]\d|100)$/.test(rawLimit))
          throw new RequestError('Invalid limit');
        const cursor = url.searchParams.get('cursor');
        if (cursor !== null && (cursor.length < 1 || cursor.length > 4096))
          throw new RequestError('Invalid cursor');
        const lifecycle = url.searchParams.get('lifecycle');
        if (lifecycle !== null && lifecycleValues[lifecycle] === undefined)
          throw new RequestError('Invalid lifecycle');
        result = await this.client.listTrips(
          {
            actor_user_id: actorUserId,
            limit: rawLimit === null ? 20 : Number(rawLimit),
            ...(cursor === null ? {} : { cursor }),
            ...(lifecycle === null ? {} : { lifecycle: lifecycleValues[lifecycle] }),
          },
          correlationId,
        );
        const items = result.items;
        if (items !== undefined && !Array.isArray(items)) throw new Error('Invalid Trip response');
        const nextCursor = result.next_cursor;
        if (nextCursor !== undefined && typeof nextCursor !== 'string')
          throw new Error('Invalid Trip response');
        return json(response, 200, {
          data: { items: (items ?? []).map(projectTrip), next_cursor: nextCursor ?? null },
          meta: { correlation_id: correlationId },
        });
      }
      if (route.route === 'get') {
        ensureQuery(url, []);
        result = await this.client.getTrip(
          { actor_user_id: actorUserId, trip_id: route.tripId },
          correlationId,
        );
        return json(response, 200, {
          data: projectTrip(result.trip),
          meta: { correlation_id: correlationId },
        });
      }
      if (route.route === 'planPolicy') {
        ensureQuery(url, []);
        const operationId = idempotencyKey(request, true)!;
        const body = await requestBody(request);
        result = await this.client.updatePlanPolicy(
          planPolicyRequest(body, actorUserId, route.tripId!, operationId),
          correlationId,
        );
        return json(response, 200, {
          data: projectPlanPolicy(result.plan_policy),
          meta: { correlation_id: correlationId },
        });
      }
      ensureQuery(url, []);
      const operationId = idempotencyKey(request, true)!;
      const body = await requestBody(request);
      result = await this.client.updateTrip(
        updateRequest(body, actorUserId, route.tripId!, operationId),
        correlationId,
      );
      return json(response, 200, {
        data: projectTrip(result.trip),
        meta: { correlation_id: correlationId },
      });
    } catch (cause) {
      if (cause instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, cause, write);
    }
  }

  close() {
    this.client.close();
  }
}
