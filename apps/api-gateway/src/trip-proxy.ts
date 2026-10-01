import {
  type RpcMessage,
  type SessionValidator,
  uuid,
  RequestError,
  isLoopbackGrpcTarget,
  responseRecord,
  onlyKeys,
  requiredString,
  requiredInteger,
  optionalString,
  enumValue,
  timestampToIso,
  json,
  fail,
  grpcFailure,
  parseTimestamp,
  validTimezone,
  idempotencyKey,
  requestBody,
  ensureQuery,
  authenticate,
} from './trip-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TripClient } from './trip-client';

type Route = 'create' | 'list' | 'get' | 'update' | 'planPolicy';

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

    const auth = await authenticate(request, response, this.validateSession, write);
    if (!auth) return;
    const { actorUserId, correlationId } = auth;

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
