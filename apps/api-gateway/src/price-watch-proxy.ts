import type { IncomingMessage, ServerResponse } from 'node:http';
import { AutomationClient } from '@wolfari/contracts/automation-client';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  idempotencyKey,
  isLoopbackGrpcTarget,
  json,
  onlyKeys,
  optionalString,
  parseTimestamp,
  record,
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
  kind: 'create' | 'list' | 'update' | 'pause' | 'resume' | 'stop' | 'observations';
  tripId?: string;
  watchId?: string;
};

const watchStatuses = { 1: 'ACTIVE', 2: 'PAUSED', 3: 'EXPIRED', 4: 'STOPPED' };
const journeyTypes = { 1: 'ONE_WAY', 2: 'ROUND_TRIP' };

export function priceWatchRoute(method: string, path: string): Route | null {
  let match = /^\/api\/v1\/trips\/([^/]+)\/price-watches$/.exec(path);
  if (match) {
    if (!uuid.test(match[1]!)) throw new RequestError('Invalid trip id');
    if (method === 'POST') return { kind: 'create', tripId: match[1]!.toLowerCase() };
    if (method === 'GET') return { kind: 'list', tripId: match[1]!.toLowerCase() };
    return null;
  }
  match = /^\/api\/v1\/price-watches\/([^/]+)(?:\/(pause|resume|stop|observations))?$/.exec(path);
  if (!match) return null;
  if (!uuid.test(match[1]!)) throw new RequestError('Invalid watch id');
  const action = match[2];
  if (!action && method === 'PATCH') return { kind: 'update', watchId: match[1]!.toLowerCase() };
  if (action === 'observations' && method === 'GET')
    return { kind: 'observations', watchId: match[1]!.toLowerCase() };
  if (action && action !== 'observations' && method === 'POST')
    return { kind: action as 'pause' | 'resume' | 'stop', watchId: match[1]!.toLowerCase() };
  return null;
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > 2_147_483_647)
    throw new RequestError('Invalid integer');
  return Number(value);
}

function journey(value: unknown): number {
  if (value === 'ONE_WAY') return 1;
  if (value === 'ROUND_TRIP') return 2;
  throw new RequestError('Invalid journey_type');
}

function passengers(value: unknown): RpcMessage {
  const item = record(value);
  onlyKeys(item, ['adults', 'children', 'infants']);
  return {
    adults: integer(item.adults, 1),
    children: item.children === undefined ? 0 : integer(item.children),
    infants: item.infants === undefined ? 0 : integer(item.infants),
  };
}

function amount(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    throw new RequestError('Invalid amount');
  return value;
}

export function priceWatchWrite(body: RpcMessage, patch: boolean): RpcMessage {
  onlyKeys(body, [
    ...(patch ? ['expected_version'] : []),
    'provider',
    'origin',
    'destination',
    'departure_date',
    'return_date',
    'journey_type',
    'passengers',
    'cabin_class',
    'currency',
    'threshold_price',
    'departure_at',
  ]);
  const result: RpcMessage = {};
  for (const key of ['provider', 'origin', 'destination', 'departure_date', 'currency'] as const) {
    if (patch && !Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== 'string') throw new RequestError(`Invalid ${key}`);
    result[key] = body[key];
  }
  if (!patch || Object.hasOwn(body, 'journey_type'))
    result.journey_type = journey(body.journey_type);
  if (!patch || Object.hasOwn(body, 'passengers')) result.passengers = passengers(body.passengers);
  if (!patch || Object.hasOwn(body, 'threshold_price'))
    result.threshold_price = amount(body.threshold_price);
  if (!patch || Object.hasOwn(body, 'departure_at'))
    result.departure_at = parseTimestamp(body.departure_at);
  for (const key of ['return_date', 'cabin_class'] as const) {
    if (!Object.hasOwn(body, key)) continue;
    if (body[key] === null) {
      if (patch) result[key] = { clear: true };
      continue;
    }
    if (typeof body[key] !== 'string') throw new RequestError(`Invalid ${key}`);
    result[key] = patch ? { value: body[key] } : body[key];
  }
  if (patch) {
    result.expected_version = integer(body.expected_version, 1);
    if (Object.keys(result).length === 1) throw new RequestError('Missing update');
  }
  return result;
}

function enumName(value: unknown, names: Record<number, string>): string {
  if (typeof value === 'string') {
    const found = Object.values(names).find((name) => value === name || value.endsWith(`_${name}`));
    if (found) return found;
  }
  const found = names[Number(value)];
  if (!found) throw new Error('Invalid Automation response');
  return found;
}

function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid Automation response');
  return value;
}

function projectQuery(value: unknown) {
  const item = responseRecord(value);
  const mix = responseRecord(item.passengers);
  return {
    provider: requiredString(item.provider),
    transport_type: requiredString(item.transport_type),
    origin: requiredString(item.origin),
    destination: requiredString(item.destination),
    departure_date: requiredString(item.departure_date),
    return_date: optionalString(item.return_date),
    journey_type: enumName(item.journey_type, journeyTypes),
    passengers: {
      adults: requiredInteger(mix.adults),
      children: integer(mix.children),
      infants: integer(mix.infants),
    },
    cabin_class: optionalString(item.cabin_class),
    currency: requiredString(item.currency),
    departure_at: timestampToIso(item.departure_at),
  };
}

function projectWatch(value: unknown) {
  const item = responseRecord(value);
  return {
    id: requiredString(item.id),
    trip_id: requiredString(item.trip_id),
    user_id: requiredString(item.user_id),
    query_group_id: requiredString(item.query_group_id),
    threshold_price: requiredString(item.threshold_price),
    currency: requiredString(item.currency),
    status: enumName(item.status, watchStatuses),
    status_reason: optionalString(item.status_reason),
    version: requiredInteger(item.version),
    expires_at: timestampToIso(item.expires_at),
    last_alert_price: optionalString(item.last_alert_price),
    last_alert_at: item.last_alert_at === undefined ? null : timestampToIso(item.last_alert_at),
    normalized_query: projectQuery(item.normalized_query),
    created_at: timestampToIso(item.created_at),
    updated_at: timestampToIso(item.updated_at),
  };
}

function projectObservation(value: unknown) {
  const item = responseRecord(value);
  let fareMetadata: unknown;
  try {
    fareMetadata = responseRecord(JSON.parse(requiredString(item.fare_metadata_json)));
  } catch {
    throw new Error('Invalid Automation response');
  }
  return {
    id: requiredString(item.id),
    price: requiredString(item.price),
    currency: requiredString(item.currency),
    provider: requiredString(item.provider),
    observed_at: timestampToIso(item.observed_at),
    fetched_at: timestampToIso(item.fetched_at),
    fare_metadata: fareMetadata,
  };
}

function queryPage(url: URL): { limit: number; cursor?: string } {
  ensureQuery(url, ['limit', 'cursor']);
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RequestError('Invalid limit');
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && (!cursor || cursor.length > 1000))
    throw new RequestError('Invalid cursor');
  return { limit, ...(cursor ? { cursor } : {}) };
}

export class PriceWatchProxy {
  private readonly client: AutomationClient;
  constructor(private readonly validateSession: SessionValidator) {
    const target = process.env.AUTOMATION_GRPC_TARGET ?? '127.0.0.1:3205';
    const secret = process.env.GATEWAY_AUTOMATION_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32)
      throw new Error('Gateway Automation configuration invalid');
    if (process.env.NODE_ENV === 'production')
      throw new Error('Gateway Automation transport requires TLS in production');
    this.client = new AutomationClient(target, secret);
  }

  matches(request: IncomingMessage & { originalUrl?: string }): boolean {
    try {
      const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname;
      return /\/price-watches(?:\/|$)/.test(path);
    } catch {
      return false;
    }
  }

  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    let parsed: Route | null;
    let url: URL;
    try {
      url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
      parsed = priceWatchRoute(request.method ?? '', url.pathname);
    } catch (error) {
      return fail(
        response,
        error instanceof RequestError ? 400 : 404,
        error instanceof RequestError ? 'VALIDATION_FAILED' : 'RESOURCE_NOT_FOUND',
      );
    }
    if (!parsed) return fail(response, 404, 'RESOURCE_NOT_FOUND');
    const writeRequest = parsed.kind !== 'list' && parsed.kind !== 'observations';
    const auth = await authenticate(request, response, this.validateSession, writeRequest);
    if (!auth) return;
    try {
      if (parsed.kind === 'list' || parsed.kind === 'observations') {
        const page = queryPage(url);
        const result = await this.client.call<RpcMessage, RpcMessage>(
          parsed.kind === 'list' ? 'ListPriceWatches' : 'ListPriceObservations',
          {
            actor_user_id: auth.actorUserId,
            ...(parsed.tripId ? { trip_id: parsed.tripId } : { watch_id: parsed.watchId }),
            ...page,
          },
          auth.correlationId,
        );
        const data =
          parsed.kind === 'list'
            ? list(result.items).map(projectWatch)
            : list(result.items).map(projectObservation);
        return json(response, 200, {
          data,
          meta: {
            correlation_id: auth.correlationId,
            next_cursor: optionalString(result.next_cursor),
          },
        });
      }
      ensureQuery(url, []);
      if (parsed.kind === 'create') {
        const result = await this.client.call<RpcMessage, RpcMessage>(
          'CreatePriceWatch',
          {
            actor_user_id: auth.actorUserId,
            trip_id: parsed.tripId,
            client_request_id: idempotencyKey(request, true),
            watch: priceWatchWrite(await requestBody(request), false),
          },
          auth.correlationId,
        );
        return json(response, 201, {
          data: projectWatch(result.watch),
          meta: { correlation_id: auth.correlationId },
        });
      }
      const body = await requestBody(request);
      if (parsed.kind === 'update') {
        const input = priceWatchWrite(body, true);
        const result = await this.client.call<RpcMessage, RpcMessage>(
          'UpdatePriceWatch',
          {
            actor_user_id: auth.actorUserId,
            watch_id: parsed.watchId,
            expected_version: input.expected_version,
            patch: Object.fromEntries(
              Object.entries(input).filter(([key]) => key !== 'expected_version'),
            ),
          },
          auth.correlationId,
        );
        return json(response, 200, {
          data: projectWatch(result.watch),
          meta: { correlation_id: auth.correlationId },
        });
      }
      onlyKeys(body, ['expected_version']);
      const method = `${parsed.kind[0]!.toUpperCase()}${parsed.kind.slice(1)}PriceWatch`;
      const result = await this.client.call<RpcMessage, RpcMessage>(
        method,
        {
          actor_user_id: auth.actorUserId,
          watch_id: parsed.watchId,
          expected_version: integer(body.expected_version, 1),
        },
        auth.correlationId,
      );
      return json(response, 200, {
        data: projectWatch(result.watch),
        meta: { correlation_id: auth.correlationId },
      });
    } catch (error) {
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, writeRequest);
    }
  }

  close(): void {
    this.client.close();
  }
}
