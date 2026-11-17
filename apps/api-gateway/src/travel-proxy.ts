import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS, TravelV1 } from '@wolfari/contracts/grpc';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  isLoopbackGrpcTarget,
  json,
  RequestError,
  timestampToIso,
  uuid,
  type SessionValidator,
} from './trip-http';

const service = loadSync(PROTO_PATHS.travel, GRPC_LOADER_OPTIONS)[
  'wolfari.travel.v1.TravelService'
] as ServiceDefinition;
export class TravelProxy {
  private readonly client?: Client;
  private readonly secret: string;
  private readonly requests = new Map<string, { count: number; until: number }>();
  constructor(private readonly validateSession: SessionValidator) {
    const target = process.env.TRAVEL_GRPC_TARGET;
    this.secret = process.env.GATEWAY_TRAVEL_SECRET ?? '';
    // Existing installations still start before env:init supplies this optional integration.
    if (target && isLoopbackGrpcTarget(target) && this.secret.length >= 32)
      this.client = new Client(target, credentials.createInsecure());
  }
  matches(request: IncomingMessage & { originalUrl?: string }) {
    return (
      new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname ===
      '/api/v1/travel/places'
    );
  }
  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') return fail(response, 404, 'RESOURCE_NOT_FOUND');
    const auth = await authenticate(request, response, this.validateSession, false);
    if (!auth) return;
    try {
      const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
      ensureQuery(url, ['q', 'trip_id']);
      const query = url.searchParams.get('q')?.trim(),
        tripId = url.searchParams.get('trip_id');
      if (
        !tripId ||
        !uuid.test(tripId) ||
        !query ||
        [...query].length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(query)
      )
        throw new RequestError('Invalid search');
      if (!this.client) return fail(response, 503, 'SERVICE_UNAVAILABLE');
      const now = Date.now(),
        old = this.requests.get(auth.actorUserId);
      const counter = old && old.until > now ? old : { count: 0, until: now + 60000 };
      if (++counter.count > 30) return fail(response, 429, 'RATE_LIMITED');
      if (this.requests.size >= 5000)
        for (const [key, value] of this.requests) if (value.until <= now) this.requests.delete(key);
      if (this.requests.size >= 5000 && !this.requests.has(auth.actorUserId))
        return fail(response, 429, 'RATE_LIMITED');
      this.requests.set(auth.actorUserId, counter);
      const method = service.SearchPlaces as MethodDefinition<
        TravelV1.SearchPlacesRequest,
        TravelV1.SearchPlacesResponse
      >;
      const metadata = new Metadata();
      metadata.set('x-caller-service', 'ApiGateway');
      metadata.set('x-service-secret', this.secret);
      metadata.set('x-correlation-id', auth.correlationId);
      const result = await new Promise<TravelV1.SearchPlacesResponse>((resolve, reject) =>
        this.client!.makeUnaryRequest(
          method.path,
          method.requestSerialize,
          method.responseDeserialize,
          { query, actor_user_id: auth.actorUserId, trip_id: tripId.toLowerCase() },
          metadata,
          { deadline: Date.now() + 5000 },
          (error: ServiceError | null, value?: TravelV1.SearchPlacesResponse) =>
            error ? reject(error) : resolve(value!),
        ),
      );
      if (!result.meta || ![1, 2, 3].includes(Number(result.meta.status)))
        throw Error('Invalid Travel response');
      json(response, 200, {
        data: (result.data ?? []).map((row) => ({
          ...row,
          opening_hours: row.opening_hours ?? [],
        })),
        meta: {
          ...result.meta,
          status: ({ 1: 'SUCCESS', 2: 'NO_RESULT', 3: 'ERROR' } as Record<number, string>)[
            result.meta.status!
          ],
          fetched_at: timestampToIso(result.meta.fetched_at),
          warnings: result.meta.warnings ?? [],
          attribution: result.meta.attribution ?? [],
          correlation_id: auth.correlationId,
        },
      });
    } catch (error) {
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, false);
    }
  }
  close() {
    this.client?.close();
  }
}
