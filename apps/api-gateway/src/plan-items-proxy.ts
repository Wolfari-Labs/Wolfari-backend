import type { IncomingMessage, ServerResponse } from 'node:http';
import { TripClient } from './trip-client';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  idempotencyKey,
  isLoopbackGrpcTarget,
  json,
  onlyKeys,
  record,
  requestBody,
  RequestError,
  responseRecord,
  uuid,
  type SessionValidator,
} from './trip-http';
import { projectLocation, projectPackingItem, projectPlanVersion } from './plan-proxy';

export function planItemRoute(method: string, path: string) {
  const match =
    /^\/api\/v1\/trips\/([^/]+)\/(packing-items|selected-locations)(?:\/([^/]+))?(?:\/(completion))?$/.exec(
      path,
    );
  if (!match) return null;
  const [, tripId, collection, itemId, completion] = match;
  if (!uuid.test(tripId!) || (itemId && !uuid.test(itemId))) throw new RequestError('Invalid ID');
  const entity_type = collection === 'selected-locations' ? 'SELECTED_LOCATION' : 'PACKING_ITEM';
  const action =
    !itemId && method === 'POST'
      ? 'CREATE'
      : itemId && completion && collection === 'packing-items' && method === 'PATCH'
        ? 'COMPLETE'
        : itemId && !completion && method === 'PATCH'
          ? 'UPDATE'
          : itemId && !completion && method === 'DELETE'
            ? 'DELETE'
            : null;
  return action
    ? { trip_id: tripId!.toLowerCase(), item_id: itemId?.toLowerCase(), entity_type, action }
    : null;
}

export class PlanItemsProxy {
  private readonly client: TripClient;
  constructor(private readonly validateSession: SessionValidator) {
    const target = process.env.TRIP_GRPC_TARGET ?? '127.0.0.1:3202',
      secret = process.env.GATEWAY_TRIP_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32)
      throw new Error('Gateway Trip configuration invalid');
    this.client = new TripClient(target, secret);
  }
  matches(request: IncomingMessage & { originalUrl?: string }) {
    return /^\/api\/v1\/trips\/[^/]+\/(packing-items|selected-locations)(?:\/|$)/.test(
      new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname,
    );
  }
  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
    try {
      const route = planItemRoute(request.method ?? '', url.pathname);
      if (!route) return fail(response, 404, 'RESOURCE_NOT_FOUND');
      const auth = await authenticate(request, response, this.validateSession, true);
      if (!auth) return;
      ensureQuery(url, []);
      const body = record(await requestBody(request));
      const fields =
        route.action === 'DELETE'
          ? []
          : route.action === 'COMPLETE'
            ? ['status']
            : route.entity_type === 'SELECTED_LOCATION'
              ? ['name', 'address', 'latitude', 'longitude', 'attribution']
              : ['name', 'quantity', 'unit', 'note', 'category', 'assigned_member_id', 'due_at'];
      onlyKeys(body, ['expected_plan_version', ...fields]);
      const revision = Number(body.expected_plan_version);
      if (!Number.isInteger(body.expected_plan_version)) throw new RequestError('Invalid version');
      if (revision < 1 || revision > 2147483647) throw new RequestError('Invalid version');
      const values = Object.fromEntries(
        fields.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]),
      );
      const result = await this.client.call(
        'MutatePlanItem',
        {
          ...route,
          operation_id: idempotencyKey(request, true),
          actor_user_id: auth.actorUserId,
          expected_plan_version: revision,
          fields_json: JSON.stringify(values),
        },
        auth.correlationId,
      );
      const version = projectPlanVersion(result.version);
      // Trip has already validated and projected these rows; keep the public DTO allowlist here too.
      const item =
        result.item_json === undefined
          ? undefined
          : responseRecord(JSON.parse(String(result.item_json)));
      // JSON fields contain public string enums, unlike the protobuf Plan projection.
      const enumRow = item
        ? {
            ...item,
            scope_type: ({ TRIP: 1, DAY: 2, ACTIVITY: 3 } as Record<string, number>)[
              String(item.scope_type)
            ],
            source: ({ MANUAL: 1, PROVIDER: 2, DSS: 3 } as Record<string, number>)[
              String(item.source)
            ],
            status: item.status === 'COMPLETED' ? 2 : 1,
          }
        : undefined;
      if (item && (item.trip_id !== route.trip_id || (route.item_id && item.id !== route.item_id)))
        throw new Error('Invalid Plan item response');
      // Packing timestamps are already ISO strings; the protobuf projector accepts wire timestamps only.
      const data =
        route.action === 'DELETE'
          ? { ...version, deleted: true }
          : route.entity_type === 'SELECTED_LOCATION'
            ? projectLocation({
                ...enumRow,
                metadata_json: JSON.stringify(item?.metadata ?? {}),
                fetched_at: undefined,
                opening_hours_json: undefined,
              })
            : {
                ...projectPackingItem({ ...enumRow, due_at: undefined, completed_at: undefined }),
                due_at: item?.due_at ?? null,
                completed_at: item?.completed_at ?? null,
              };
      json(response, route.action === 'CREATE' ? 201 : 200, {
        data,
        meta: { correlation_id: auth.correlationId, export_revision: version.export_revision },
      });
    } catch (error) {
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, true);
    }
  }
  close() {
    this.client.close();
  }
}
