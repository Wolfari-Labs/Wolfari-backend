import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type ServiceDefinition, type MethodDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { productionTransportBlocked } from '@wolfari/common';
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
  requestBody,
  RequestError,
  responseRecord,
  timestampToIso,
  uuid,
  type SessionValidator,
} from './trip-http';
const service = loadSync(PROTO_PATHS.travel, GRPC_LOADER_OPTIONS)[
  'wolfari.travel.v1.TravelService'
] as ServiceDefinition;
const PLACE_PROVIDERS = ['WOLFARI', 'GEOAPIFY'];
const SEARCH_PROVIDERS = ['WOLFARI', 'GEOAPIFY', 'WOLFARI+GEOAPIFY'];
const SOURCE_DATASETS = ['golden', 'overture', 'geoapify'];
/** POI-OVERTURE §4.1 `category` values; absent = the 4 default groups. */
export const PLACE_SEARCH_GROUPS = [
  'tourism',
  'restaurant',
  'cafe',
  'accommodation',
  'nightlife',
  'shopping',
  'entertainment',
  'wellness',
  'transport',
  'services',
  'other',
  'all',
];
/** 400 with a specific error code (INVALID_BBOX, BBOX_TOO_LARGE). */
export class BboxError extends Error {}
/** `bbox=minLon,minLat,maxLon,maxLat`, at most 2° per side. */
export function parseBbox(value: string | null) {
  if (value === null) return undefined;
  const parts = value.split(',');
  const numbers = parts.map((part) =>
    /^-?\d{1,3}(\.\d{1,8})?$/.test(part.trim()) ? Number(part) : NaN,
  );
  if (parts.length !== 4 || numbers.some((n) => !Number.isFinite(n)))
    throw new BboxError('INVALID_BBOX');
  const [minLon, minLat, maxLon, maxLat] = numbers as [number, number, number, number];
  if (
    minLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    maxLat > 90 ||
    minLon >= maxLon ||
    minLat >= maxLat
  )
    throw new BboxError('INVALID_BBOX');
  if (maxLon - minLon > 2 || maxLat - minLat > 2) throw new BboxError('BBOX_TOO_LARGE');
  return {
    min_longitude: minLon,
    min_latitude: minLat,
    max_longitude: maxLon,
    max_latitude: maxLat,
  };
}
/**
 * Public Place shape (MAP-POI §4.1). proto-loader runs with defaults:false, so empty/false/0
 * fields and proto3 `optional` virtual oneof keys (`_name`) are normalized here.
 */
export function publicPlace(value: unknown): Record<string, unknown> {
  const row = responseRecord(value);
  const fields = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_')));
  const text = (key: string) => (typeof row[key] === 'string' ? row[key] : '');
  const provider = PLACE_PROVIDERS.includes(text('provider')) ? text('provider') : 'GEOAPIFY';
  const duration = row.typical_duration_min;
  delete fields.typical_duration_min;
  delete fields.fetched_at;
  delete fields.confidence;
  const confidence = row.confidence;
  const dataset = text('source_dataset');
  return {
    ...fields,
    address: text('address'),
    categories: Array.isArray(row.categories) ? row.categories : [],
    provider,
    category: text('category'),
    category_label: text('category_label'),
    tier: typeof row.tier === 'number' && Number.isInteger(row.tier) && row.tier > 0 ? row.tier : 9,
    coord_verified: row.coord_verified === true,
    ...(typeof duration === 'number' && Number.isInteger(duration) && duration > 0
      ? { typical_duration_min: duration }
      : {}),
    activity_type: text('activity_type'),
    dress_code_hint: text('dress_code_hint'),
    // POI-OVERTURE (additive, nullable).
    source_dataset: SOURCE_DATASETS.includes(dataset)
      ? dataset
      : provider === 'WOLFARI'
        ? 'golden'
        : 'geoapify',
    category_group: text('category_group') || null,
    province_code: text('province_code') || null,
    province_name: text('province_name') || null,
    confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null,
    data_release: text('data_release') || null,
    fetched_at: row.fetched_at ? timestampToIso(row.fetched_at) : null,
  };
}
export class PlacesProxy {
  private readonly trip: TripClient;
  private travel?: Client;
  constructor(private readonly validate: SessionValidator) {
    const target = process.env.TRIP_GRPC_TARGET ?? '127.0.0.1:3202';
    const secret = process.env.GATEWAY_TRIP_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32 || productionTransportBlocked())
      throw new Error('Places Trip transport invalid');
    this.trip = new TripClient(target, secret);
  }
  matches(request: IncomingMessage & { originalUrl?: string }) {
    try {
      return /^\/api\/v1\/trips\/[^/]+\/(places|selected-locations)(\/|$)/.test(
        new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname,
      );
    } catch {
      return false;
    }
  }
  private search(
    input: Record<string, unknown>,
    correlation: string,
  ): Promise<Record<string, unknown>> {
    const target = process.env.TRAVEL_GRPC_TARGET ?? '127.0.0.1:3203';
    const secret = process.env.GATEWAY_TRAVEL_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32)
      return Promise.reject(new Error('Travel unavailable'));
    this.travel ??= new Client(target, credentials.createInsecure());
    const method = service.SearchPlaces as MethodDefinition<
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
        { deadline: Date.now() + 8000 },
        (error: ServiceError | null, result?: Record<string, unknown>) =>
          error ? reject(error) : resolve(result!),
      ),
    );
  }
  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
      const match =
        /^\/api\/v1\/trips\/([^/]+)\/(places\/search|selected-locations)(?:\/([^/]+))?$/.exec(
          url.pathname,
        );
      if (!match || !uuid.test(match[1]!)) return fail(response, 404, 'RESOURCE_NOT_FOUND');
      const tripId = match[1]!.toLowerCase(),
        search = match[2] === 'places/search';
      if (
        (search && (request.method !== 'GET' || match[3])) ||
        (!search &&
          !(request.method === 'POST' && !match[3]) &&
          !(request.method === 'DELETE' && uuid.test(match[3] ?? '')))
      )
        return fail(response, 404, 'RESOURCE_NOT_FOUND');
      const auth = await authenticate(request, response, this.validate, !search);
      if (!auth) return;
      const planResult = await this.trip.getPlan(
        { actor_user_id: auth.actorUserId, trip_id: tripId },
        auth.correlationId,
      );
      const plan = responseRecord(planResult.plan);
      if (search) {
        ensureQuery(url, [
          'q',
          'latitude',
          'longitude',
          'radius_m',
          'category',
          'geocode',
          'bbox',
          'limit',
        ]);
        const bbox = parseBbox(url.searchParams.get('bbox'));
        const limitText = url.searchParams.get('limit');
        if (limitText !== null && (!/^\d{1,3}$/.test(limitText) || +limitText < 1 || +limitText > 300))
          throw new RequestError('Invalid limit');
        const category = url.searchParams.get('category') ?? '';
        if (category && !PLACE_SEARCH_GROUPS.includes(category))
          throw new RequestError('Invalid category');
        const number = (key: string, fallback: number) => {
          const value = url.searchParams.get(key);
          if (value === '') throw new RequestError('Invalid coordinate');
          const n = value === null ? fallback : Number(value);
          if (!Number.isFinite(n)) throw new RequestError('Invalid coordinate');
          return n;
        };
        const radius = number('radius_m', 5000);
        if (
          !Number.isInteger(radius) ||
          radius < 100 ||
          radius > 20000 ||
          !['true', 'false'].includes(url.searchParams.get('geocode') ?? 'false')
        )
          throw new RequestError('Invalid search');
        const result = await this.search(
          {
            actor_user_id: auth.actorUserId,
            trip_id: tripId,
            query: url.searchParams.get('q') ?? '',
            coordinates: {
              latitude: number('latitude', 16.0544),
              longitude: number('longitude', 108.2022),
            },
            radius_m: radius,
            category,
            geocode: url.searchParams.get('geocode') === 'true',
            ...(bbox ? { bbox } : {}),
            ...(limitText !== null ? { limit: Number(limitText) } : {}),
          },
          auth.correlationId,
        );
        const meta = responseRecord(result.meta);
        const rows = Array.isArray(result.data) ? result.data : [];
        return json(response, 200, {
          data: rows.map(publicPlace),
          meta: {
            provider: SEARCH_PROVIDERS.includes(String(meta.provider)) ? meta.provider : 'GEOAPIFY',
            status: { 1: 'SUCCESS', 2: 'NO_RESULT', 3: 'ERROR' }[Number(meta.status)],
            fetched_at: meta.fetched_at ? timestampToIso(meta.fetched_at) : null,
            stale: meta.stale === true,
            is_mock: false,
            warnings: meta.warnings ?? [],
            snapshot_id:
              typeof meta.snapshot_id === 'string' && meta.snapshot_id ? meta.snapshot_id : null,
            data_release:
              typeof meta.data_release === 'string' && meta.data_release ? meta.data_release : null,
            bbox_truncated: meta.bbox_truncated === true,
          },
        });
      }
      if (responseRecord(plan.permissions).can_edit !== true)
        return fail(response, 403, 'PERMISSION_DENIED');
      ensureQuery(url, []);
      const body = await requestBody(request);
      const deleting = request.method === 'DELETE';
      onlyKeys(
        body,
        deleting
          ? ['expected_plan_version']
          : [
              'expected_plan_version',
              'selection_token',
              'name',
              'address',
              'latitude',
              'longitude',
            ],
      );
      const expected = body.expected_plan_version;
      if (
        typeof expected !== 'number' ||
        !Number.isInteger(expected) ||
        expected < 1 ||
        expected > 2147483647
      )
        throw new RequestError('Invalid version');
      if (
        !deleting &&
        body.selection_token !== undefined &&
        (typeof body.selection_token !== 'string' ||
          !body.selection_token ||
          body.selection_token.length > 16000)
      )
        throw new RequestError('Invalid selection');
      if (
        !deleting &&
        body.selection_token !== undefined &&
        ['name', 'address', 'latitude', 'longitude'].some((k) => body[k] !== undefined)
      )
        throw new RequestError('Ambiguous selection');
      if (
        !deleting &&
        body.selection_token === undefined &&
        (typeof body.name !== 'string' ||
          !body.name.trim() ||
          body.name.length > 255 ||
          (body.address !== undefined &&
            (typeof body.address !== 'string' || body.address.length > 1000)) ||
          typeof body.latitude !== 'number' ||
          !Number.isFinite(body.latitude) ||
          Math.abs(body.latitude) > 90 ||
          typeof body.longitude !== 'number' ||
          !Number.isFinite(body.longitude) ||
          Math.abs(body.longitude) > 180)
      )
        throw new RequestError('Invalid location');
      const result = await this.trip.call(
        deleting ? 'DeleteSelectedLocation' : 'SaveSelectedLocation',
        {
          ...body,
          ...(deleting ? { location_id: match[3]!.toLowerCase() } : {}),
          actor_user_id: auth.actorUserId,
          trip_id: tripId,
          operation_id: idempotencyKey(request, true),
          expected_plan_version: expected,
        },
        auth.correlationId,
      );
      return json(response, deleting ? 200 : 201, {
        data: result,
        meta: { correlation_id: auth.correlationId },
      });
    } catch (error) {
      if (error instanceof BboxError) return fail(response, 400, error.message);
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, request.method !== 'GET');
    }
  }
  close() {
    this.trip.close();
    this.travel?.close();
  }
}
