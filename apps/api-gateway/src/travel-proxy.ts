import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from '@wolfari/contracts/grpc';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  isLoopbackGrpcTarget,
  json,
  onlyKeys,
  record,
  requestBody,
  RequestError,
  responseRecord,
  timestampToIso,
  type SessionValidator,
} from './trip-http';

const service = loadSync(PROTO_PATHS.travel, GRPC_LOADER_OPTIONS)[
  'wolfari.travel.v1.TravelService'
] as ServiceDefinition;
const MODES: Record<string, number> = { DRIVING: 2, WALKING: 1, CYCLING: 3 };
const ROUTE_LIMIT_PER_MINUTE = 60;

/** Per-user token bucket for POST /api/v1/travel/route (60 requests/minute). */
const buckets = new Map<string, { tokens: number; refilledAt: number }>();
export function allowRouteRequest(user: string, now = Date.now()): boolean {
  const bucket = buckets.get(user) ?? { tokens: ROUTE_LIMIT_PER_MINUTE, refilledAt: now };
  const refill = ((now - bucket.refilledAt) / 60_000) * ROUTE_LIMIT_PER_MINUTE;
  bucket.tokens = Math.min(ROUTE_LIMIT_PER_MINUTE, bucket.tokens + refill);
  bucket.refilledAt = now;
  if (buckets.size > 10_000) buckets.clear();
  buckets.set(user, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Validate the public body (MAP-POI §4.4) into a Travel GetRouteRequest. */
export function routeRequest(body: Record<string, unknown>) {
  onlyKeys(body, ['coordinates', 'mode']);
  const mode = body.mode === undefined ? 'DRIVING' : body.mode;
  if (typeof mode !== 'string' || !Object.hasOwn(MODES, mode))
    throw new RequestError('Invalid mode');
  if (
    !Array.isArray(body.coordinates) ||
    body.coordinates.length < 2 ||
    body.coordinates.length > 25
  )
    throw new RequestError('Invalid coordinates');
  const coordinates = body.coordinates.map((value) => {
    const point = record(value);
    onlyKeys(point, ['latitude', 'longitude']);
    const { latitude, longitude } = point;
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      throw new RequestError('Invalid coordinate');
    return { latitude, longitude };
  });
  return { coordinates, mode: MODES[mode]! };
}

/** OpenStreetMap credit the client must show next to a road route (https only, short text). */
export function routeAttribution(value: unknown): { text: string; url: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const entry = item as Record<string, unknown>;
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, 120) : '';
    const url =
      typeof entry.url === 'string' && /^https:\/\/[^\s]+$/.test(entry.url) ? entry.url : null;
    return text ? [{ text, url }] : [];
  });
}

export class TravelProxy {
  private travel?: Client;
  constructor(private readonly validate: SessionValidator) {}
  matches(request: IncomingMessage & { originalUrl?: string }) {
    try {
      return /^\/api\/v1\/travel\/route\/?$/.test(
        new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname,
      );
    } catch {
      return false;
    }
  }
  private getRoute(
    input: Record<string, unknown>,
    correlation: string,
  ): Promise<Record<string, unknown>> {
    const target = process.env.TRAVEL_GRPC_TARGET ?? '127.0.0.1:3203';
    const secret = process.env.GATEWAY_TRAVEL_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32)
      return Promise.reject(new Error('Travel unavailable'));
    this.travel ??= new Client(target, credentials.createInsecure());
    const method = service.GetRoute as MethodDefinition<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'ApiGateway');
    metadata.set('x-service-secret', secret);
    metadata.set('x-correlation-id', correlation);
    return new Promise((resolve, reject) =>
      this.travel!.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        input,
        metadata,
        { deadline: Date.now() + 6000 },
        (error: ServiceError | null, result?: Record<string, unknown>) =>
          error ? reject(error) : resolve(result!),
      ),
    );
  }
  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
      if (url.pathname.replace(/\/$/, '') !== '/api/v1/travel/route' || request.method !== 'POST')
        return fail(response, 404, 'RESOURCE_NOT_FOUND');
      const auth = await authenticate(request, response, this.validate, false);
      if (!auth) return;
      if (!allowRouteRequest(auth.actorUserId))
        return fail(response, 429, 'RESOURCE_EXHAUSTED', { retryable: true });
      ensureQuery(url, []);
      const input = routeRequest(await requestBody(request));
      const result = await this.getRoute(input, auth.correlationId);
      const meta = responseRecord(result.meta);
      const status = { 1: 'SUCCESS', 2: 'NO_RESULT', 3: 'ERROR' }[Number(meta.status)];
      const warnings = Array.isArray(meta.warnings) ? meta.warnings.map(String) : [];
      // OSRM not configured/unreachable: the client draws a labelled straight line instead.
      if (status !== 'SUCCESS' && status !== 'NO_RESULT')
        return fail(response, 503, 'SERVICE_UNAVAILABLE', {
          retryable: !warnings.includes('PROVIDER_NOT_CONFIGURED'),
          details: { provider: 'OSRM', reason: warnings[0] ?? 'PROVIDER_UNAVAILABLE' },
        });
      const data = result.data ? responseRecord(result.data) : null;
      return json(response, 200, {
        data: data
          ? {
              distance_m: Number(data.distance_m ?? 0),
              duration_seconds: Number(data.duration_seconds ?? 0),
              geometry: (Array.isArray(data.geometry) ? data.geometry : []).map((point) => {
                const p = responseRecord(point);
                return { latitude: Number(p.latitude ?? 0), longitude: Number(p.longitude ?? 0) };
              }),
            }
          : null,
        meta: {
          status,
          provider: 'OSRM',
          fetched_at: meta.fetched_at ? timestampToIso(meta.fetched_at) : null,
          stale: meta.stale === true,
          is_mock: false,
          warnings,
          attribution: routeAttribution(meta.attribution),
        },
      });
    } catch (error) {
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, false);
    }
  }
  close() {
    this.travel?.close();
  }
}
