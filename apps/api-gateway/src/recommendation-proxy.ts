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
  uuid,
  type SessionValidator,
} from './trip-http';

const TYPES = new Set(['PACKING', 'DRESS_CODE', 'ALL']);
const ITEM_ID = /^[0-9a-f]{24}$/;

/** FR-DS01: preview → apply/ignore for rule-based packing and dress-code suggestions. */
export function recommendationRoute(method: string, path: string) {
  const preview = /^\/api\/v1\/trips\/([^/]+)\/recommendations\/?$/.exec(path);
  if (preview) {
    if (!uuid.test(preview[1]!)) throw new RequestError('Invalid ID');
    return method === 'POST' ? { action: 'PREVIEW' as const, id: preview[1]!.toLowerCase() } : null;
  }
  const act = /^\/api\/v1\/recommendations\/([^/]+)\/(apply|ignore)\/?$/.exec(path);
  if (!act) return null;
  if (!uuid.test(act[1]!)) throw new RequestError('Invalid ID');
  if (method !== 'POST') return null;
  return {
    action: act[2] === 'apply' ? ('APPLY' as const) : ('IGNORE' as const),
    id: act[1]!.toLowerCase(),
  };
}

function stringList(value: unknown, pattern: RegExp, max: number) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new RequestError('Invalid list');
  const out = value.map((v) => {
    if (typeof v !== 'string' || !pattern.test(v)) throw new RequestError('Invalid list item');
    return v.toLowerCase();
  });
  if (new Set(out).size !== out.length) throw new RequestError('Duplicate list item');
  return out;
}

export class RecommendationProxy {
  private readonly client: TripClient;
  constructor(private readonly validateSession: SessionValidator) {
    const target = process.env.TRIP_GRPC_TARGET ?? '127.0.0.1:3202',
      secret = process.env.GATEWAY_TRIP_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32)
      throw new Error('Gateway Trip configuration invalid');
    this.client = new TripClient(target, secret);
  }
  matches(request: IncomingMessage & { originalUrl?: string }) {
    const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname;
    return (
      /^\/api\/v1\/trips\/[^/]+\/recommendations\/?$/.test(path) ||
      /^\/api\/v1\/recommendations(?:\/|$)/.test(path)
    );
  }
  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
    try {
      const route = recommendationRoute(request.method ?? '', url.pathname);
      if (!route) return fail(response, 404, 'RESOURCE_NOT_FOUND');
      const auth = await authenticate(request, response, this.validateSession, true);
      if (!auth) return;
      ensureQuery(url, []);
      const body = record(await requestBody(request));
      let result: Record<string, unknown>;
      if (route.action === 'PREVIEW') {
        onlyKeys(body, ['type', 'date', 'activity_ids']);
        const type = body.type ?? 'ALL';
        if (typeof type !== 'string' || !TYPES.has(type)) throw new RequestError('Invalid type');
        if (
          body.date !== undefined &&
          (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date))
        )
          throw new RequestError('Invalid date');
        result = await this.client.call(
          'PreviewRecommendation',
          {
            actor_user_id: auth.actorUserId,
            trip_id: route.id,
            type,
            ...(body.date ? { date: body.date } : {}),
            activity_ids: stringList(body.activity_ids, uuid, 200),
          },
          auth.correlationId,
        );
      } else if (route.action === 'APPLY') {
        onlyKeys(body, ['item_ids', 'expected_plan_version']);
        const revision = body.expected_plan_version;
        if (
          typeof revision !== 'number' ||
          !Number.isInteger(revision) ||
          revision < 1 ||
          revision > 2147483647
        )
          throw new RequestError('Invalid version');
        const items = stringList(body.item_ids, ITEM_ID, 100);
        if (!items.length) throw new RequestError('No items selected');
        result = await this.client.call(
          'ApplyRecommendation',
          {
            actor_user_id: auth.actorUserId,
            recommendation_id: route.id,
            apply_request_id: idempotencyKey(request, true),
            item_ids: items,
            expected_plan_version: revision,
          },
          auth.correlationId,
        );
      } else {
        onlyKeys(body, []);
        result = await this.client.call(
          'IgnoreRecommendation',
          { actor_user_id: auth.actorUserId, recommendation_id: route.id },
          auth.correlationId,
        );
      }
      const data = JSON.parse(String(result.recommendation_json ?? 'null')) as Record<
        string,
        unknown
      > | null;
      if (!data || typeof data !== 'object' || data.id === undefined)
        throw new Error('Invalid recommendation response');
      if (route.action !== 'PREVIEW' && data.id !== route.id)
        throw new Error('Invalid recommendation response');
      json(response, route.action === 'PREVIEW' ? 201 : 200, {
        data,
        meta: { correlation_id: auth.correlationId },
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
