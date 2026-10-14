import type { IncomingMessage, ServerResponse } from 'node:http';
import { TripClient } from './trip-client';
import {
  authenticate,
  ensureQuery,
  enumValue,
  fail,
  grpcFailure,
  idempotencyKey,
  isLoopbackGrpcTarget,
  json,
  onlyKeys,
  optionalString,
  parseTimestamp,
  requestBody,
  RequestError,
  requiredInteger,
  requiredString,
  responseRecord,
  timestampToIso,
  uuid,
  type RpcMessage,
  type SessionValidator,
} from './trip-http';

type Route = {
  kind: 'get' | 'create' | 'update' | 'delete' | 'reorder' | 'completion';
  tripId: string;
  activityId?: string;
};
const statuses = { 1: 'TODO', 2: 'COMPLETED' };
const sources = { 1: 'MANUAL', 2: 'PROVIDER', 3: 'DSS' };
const scopes = { 1: 'TRIP', 2: 'DAY', 3: 'ACTIVITY' };
export function planRoute(method: string, path: string): Route | null {
  const match =
    /^\/api\/v1\/trips\/([^/]+)\/(plan|activities)(?:\/([^/]+))?(?:\/(completion))?$/.exec(path);
  if (!match) return null;
  const [, tripId, group, part, completion] = match;
  let kind: Route['kind'];
  if (group === 'plan' && !part && method === 'GET') kind = 'get';
  else if (group === 'activities' && !part && method === 'POST') kind = 'create';
  else if (group === 'activities' && part === 'order' && !completion && method === 'PUT')
    kind = 'reorder';
  else if (group === 'activities' && part && part !== 'order' && completion && method === 'PATCH')
    kind = 'completion';
  else if (group === 'activities' && part && part !== 'order' && !completion && method === 'PATCH')
    kind = 'update';
  else if (group === 'activities' && part && part !== 'order' && !completion && method === 'DELETE')
    kind = 'delete';
  else return null;
  if (!uuid.test(tripId!)) throw new RequestError('Invalid trip id');
  const activityId = ['update', 'delete', 'completion'].includes(kind) ? part : undefined;
  if (activityId && !uuid.test(activityId)) throw new RequestError('Invalid activity id');
  return {
    kind,
    tripId: tripId!.toLowerCase(),
    ...(activityId ? { activityId: activityId.toLowerCase() } : {}),
  };
}
export function nonNegativeInteger(value: unknown): number {
  const number = value ?? 0;
  if (!Number.isInteger(number) || Number(number) < 0) throw new Error('Invalid Plan response');
  return Number(number);
}
const optionalTime = (value: unknown) =>
  value === undefined || value === null ? null : timestampToIso(value);
const bool = (value: unknown) => {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('Invalid Plan permission');
  return value;
};
function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid Plan list');
  return value;
}
export function projectActivity(value: unknown) {
  const row = responseRecord(value);
  return {
    id: requiredString(row.id),
    trip_id: requiredString(row.trip_id),
    title: requiredString(row.title),
    description: optionalString(row.description),
    public_description: optionalString(row.public_description),
    activity_type: requiredString(row.activity_type),
    selected_location_id: optionalString(row.selected_location_id),
    starts_at: optionalTime(row.starts_at),
    ends_at: optionalTime(row.ends_at),
    position: nonNegativeInteger(row.position),
    status: enumValue(row.status, statuses),
    source: enumValue(row.source, sources),
    completed_by_user_id: optionalString(row.completed_by_user_id),
    completed_at: optionalTime(row.completed_at),
    created_by_user_id: requiredString(row.created_by_user_id),
    plan_version: requiredInteger(row.plan_version),
  };
}
export function projectLocation(value: unknown) {
  const row = responseRecord(value);
  return {
    id: requiredString(row.id),
    trip_id: requiredString(row.trip_id),
    name: requiredString(row.name),
    address: optionalString(row.address),
    latitude: optionalString(row.latitude),
    longitude: optionalString(row.longitude),
    provider: optionalString(row.provider),
    provider_place_id: optionalString(row.provider_place_id),
    source: enumValue(row.source, sources),
    fetched_at: optionalTime(row.fetched_at),
    metadata: responseRecord(JSON.parse(requiredString(row.metadata_json))),
    opening_hours:
      row.opening_hours_json === undefined
        ? null
        : (JSON.parse(requiredString(row.opening_hours_json)) as unknown),
    plan_version: requiredInteger(row.plan_version),
  };
}
export function projectDressCode(value: unknown) {
  const row = responseRecord(value);
  return {
    id: requiredString(row.id),
    trip_id: requiredString(row.trip_id),
    scope_type: enumValue(row.scope_type, scopes),
    plan_date: optionalString(row.plan_date),
    activity_id: optionalString(row.activity_id),
    label: requiredString(row.label),
    description: optionalString(row.description),
    public_description: optionalString(row.public_description),
    source: enumValue(row.source, sources),
    plan_version: requiredInteger(row.plan_version),
  };
}
export function projectPackingItem(value: unknown) {
  const row = responseRecord(value);
  return {
    id: requiredString(row.id),
    trip_id: requiredString(row.trip_id),
    name: requiredString(row.name),
    quantity: requiredString(row.quantity),
    unit: optionalString(row.unit),
    note: optionalString(row.note),
    category: optionalString(row.category),
    assigned_member_id: optionalString(row.assigned_member_id),
    due_at: optionalTime(row.due_at),
    status: enumValue(row.status, statuses),
    source: enumValue(row.source, sources),
    completed_by_user_id: optionalString(row.completed_by_user_id),
    completed_at: optionalTime(row.completed_at),
    plan_version: requiredInteger(row.plan_version),
  };
}
export function projectPlanVersion(value: unknown) {
  const row = responseRecord(value);
  return {
    trip_id: requiredString(row.trip_id),
    plan_version: requiredInteger(row.plan_version),
    export_revision: requiredInteger(row.export_revision),
  };
}
export function projectPlan(value: unknown) {
  const row = responseRecord(value),
    permissions = responseRecord(row.permissions ?? {});
  return {
    ...projectPlanVersion(row),
    activities: list(row.activities).map(projectActivity),
    selected_locations: list(row.selected_locations).map(projectLocation),
    dress_codes: list(row.dress_codes).map(projectDressCode),
    packing_items: list(row.packing_items).map(projectPackingItem),
    permissions: {
      can_read: bool(permissions.can_read),
      can_edit: bool(permissions.can_edit),
      can_complete: bool(permissions.can_complete),
    },
  };
}
function revision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647)
    throw new RequestError('Invalid plan revision');
  return Number(value);
}
export function planRequest(
  route: Route,
  body: RpcMessage,
  actorId: string,
  operationId: string,
): RpcMessage {
  const request: RpcMessage = {
    operation_id: operationId,
    actor_user_id: actorId,
    trip_id: route.tripId,
    expected_plan_version: revision(body.expected_plan_version),
  };
  if (route.activityId) request.activity_id = route.activityId;
  if (route.kind === 'delete') {
    onlyKeys(body, ['expected_plan_version', 'confirmed']);
    if (body.confirmed !== true) throw new RequestError('Deletion requires confirmation');
    return { ...request, confirmed: true };
  }
  if (route.kind === 'reorder') {
    onlyKeys(body, ['expected_plan_version', 'activity_ids']);
    if (
      !Array.isArray(body.activity_ids) ||
      body.activity_ids.some((id) => typeof id !== 'string' || !uuid.test(id))
    )
      throw new RequestError('Invalid activity ids');
    const ids = (body.activity_ids as string[]).map((id) => id.toLowerCase());
    if (new Set(ids).size !== ids.length) throw new RequestError('Duplicate activity ids');
    return { ...request, activity_ids: ids };
  }
  if (route.kind === 'completion') {
    onlyKeys(body, ['expected_plan_version', 'status']);
    if (body.status !== 'TODO' && body.status !== 'COMPLETED')
      throw new RequestError('Invalid status');
    return { ...request, status: body.status === 'TODO' ? 1 : 2 };
  }
  onlyKeys(body, [
    'expected_plan_version',
    'title',
    'activity_type',
    'description',
    'public_description',
    'selected_location_id',
    'starts_at',
    'ends_at',
    'position',
  ]);
  const create = route.kind === 'create';
  if (!create && Object.keys(body).length < 2) throw new RequestError('Missing update');
  for (const [key, max] of [
    ['title', 255],
    ['activity_type', 40],
  ] as const) {
    if (!create && !Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].trim().length > max)
      throw new RequestError(`Invalid ${key}`);
    request[key] = body[key].trim();
  }
  if (create || Object.hasOwn(body, 'position')) {
    if (
      !Number.isInteger(body.position) ||
      Number(body.position) < 0 ||
      Number(body.position) > 2_147_483_647
    )
      throw new RequestError('Invalid position');
    request.position = body.position;
  }
  for (const key of [
    'description',
    'public_description',
    'selected_location_id',
    'starts_at',
    'ends_at',
  ] as const) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (value === null) {
      if (!create) request[key] = { clear: true };
      continue;
    }
    if (typeof value !== 'string') throw new RequestError(`Invalid ${key}`);
    if (key === 'selected_location_id' && !uuid.test(value))
      throw new RequestError('Invalid location id');
    const normalized =
      key === 'starts_at' || key === 'ends_at'
        ? parseTimestamp(value)
        : key === 'selected_location_id'
          ? value.toLowerCase()
          : value;
    request[key] = create ? normalized : { value: normalized };
  }
  return request;
}
export class PlanProxy {
  private readonly client: TripClient;
  constructor(private readonly validateSession: SessionValidator) {
    const target = process.env.TRIP_GRPC_TARGET ?? '127.0.0.1:3202',
      secret = process.env.GATEWAY_TRIP_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32)
      throw new Error('Gateway Trip configuration invalid');
    if (process.env.NODE_ENV === 'production')
      throw new Error('Gateway Trip transport requires TLS in production');
    this.client = new TripClient(target, secret);
  }
  matches(request: IncomingMessage & { originalUrl?: string }): boolean {
    try {
      return /^\/api\/v1\/trips\/[^/]+\/(plan|activities)(\/.*)?$/.test(
        new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname,
      );
    } catch {
      return false;
    }
  }
  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    let route: Route | null, url: URL;
    try {
      url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
      route = planRoute(request.method ?? '', url.pathname);
    } catch (error) {
      return fail(
        response,
        error instanceof RequestError ? 400 : 404,
        error instanceof RequestError ? 'VALIDATION_FAILED' : 'RESOURCE_NOT_FOUND',
      );
    }
    if (!route) return fail(response, 404, 'RESOURCE_NOT_FOUND');
    const auth = await authenticate(request, response, this.validateSession, route.kind !== 'get');
    if (!auth) return;
    try {
      ensureQuery(url, []);
      if (route.kind === 'get') {
        const result = await this.client.getPlan(
          { actor_user_id: auth.actorUserId, trip_id: route.tripId },
          auth.correlationId,
        );
        const data = projectPlan(result.plan);
        return json(response, 200, {
          data,
          meta: { correlation_id: auth.correlationId, export_revision: data.export_revision },
        });
      }
      const operationId = idempotencyKey(request, true)!;
      const input = planRequest(route, await requestBody(request), auth.actorUserId, operationId);
      const method = {
        create: 'createActivity',
        update: 'updateActivity',
        delete: 'deleteActivity',
        reorder: 'reorderActivities',
        completion: 'setActivityCompletion',
      } as const;
      const result = await this.client[method[route.kind]](input, auth.correlationId);
      const isVersion = route.kind === 'delete' || route.kind === 'reorder';
      const data = isVersion
        ? projectPlanVersion(result.version)
        : projectActivity(result.activity);
      const exportRevision = isVersion
        ? projectPlanVersion(result.version).export_revision
        : requiredInteger(result.export_revision);
      return json(response, route.kind === 'create' ? 201 : 200, {
        data,
        meta: { correlation_id: auth.correlationId, export_revision: exportRevision },
      });
    } catch (error) {
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, route.kind !== 'get');
    }
  }
  close() {
    this.client.close();
  }
}
