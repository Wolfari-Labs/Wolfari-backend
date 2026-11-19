import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TripClient } from './trip-client';
import { readMultipartFile } from './multipart-upload';
import { authenticate, ensureQuery, fail, grpcFailure, json, RequestError, uuid, type SessionValidator } from './trip-http';

const UPLOAD_LIMIT = 5 * 1024 * 1024;
const STORED_LIMIT = 2 * 1024 * 1024;
export function tripCoverRoute(path: string): string | undefined {
  return /^\/api\/v1\/trips\/([^/]+)\/cover$/.exec(path)?.[1];
}
type Projector = (trip: unknown) => unknown;

/** POST multipart `file` (JPEG/PNG ≤5 MB) replaces, GET streams, DELETE removes the trip cover. */
export class TripCoverHttp {
  private active = 0;
  constructor(
    private readonly validate: SessionValidator,
    private readonly client: Pick<TripClient, 'call'>,
    private readonly projectTrip: Projector,
  ) {}
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, tripId: string) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const method = request.method ?? '';
    if (!['POST', 'GET', 'DELETE'].includes(method)) return fail(response, 404, 'RESOURCE_NOT_FOUND');
    const write = method !== 'GET';
    if (this.active >= 2) return fail(response, 503, 'SERVICE_UNAVAILABLE');
    this.active++;
    const abort = new AbortController(), cancel = () => abort.abort();
    request.once('aborted', cancel); response.once('close', cancel);
    try {
      const auth = await authenticate(request, response, this.validate, write);
      if (!auth) return;
      if (!uuid.test(tripId)) throw new RequestError('Invalid scope');
      ensureQuery(url, []);
      if (method !== 'POST' && (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0'))) throw new RequestError('Unexpected body');
      const scope = { actor_user_id: auth.actorUserId, trip_id: tripId.toLowerCase() };
      if (method === 'POST') {
        const file = await readMultipartFile(request, abort.signal, { maxBytes: UPLOAD_LIMIT, mimeTypes: ['image/jpeg', 'image/png'] });
        const result = await this.client.call<Record<string, unknown>, Record<string, unknown>>('UploadTripCover', { ...file, ...scope }, auth.correlationId);
        if (abort.signal.aborted) return;
        return json(response, 200, { data: this.projectTrip(result.trip), meta: { correlation_id: auth.correlationId } });
      }
      if (method === 'DELETE') {
        const result = await this.client.call<Record<string, unknown>, Record<string, unknown>>('DeleteTripCover', scope, auth.correlationId);
        if (abort.signal.aborted) return;
        return json(response, 200, { data: this.projectTrip(result.trip), meta: { correlation_id: auth.correlationId } });
      }
      const result = await this.client.call<Record<string, unknown>, Record<string, unknown>>('GetTripCover', scope, auth.correlationId);
      if (abort.signal.aborted) return;
      if (result.mime_type !== 'image/jpeg' || !Number.isInteger(result.size_bytes) || Number(result.size_bytes) < 1 || Number(result.size_bytes) > STORED_LIMIT) throw Error('Invalid image response');
      if (!Buffer.isBuffer(result.content) || result.content.length !== result.size_bytes) throw Error('Invalid image bytes');
      response.statusCode = 200;
      response.setHeader('Content-Type', 'image/jpeg'); response.setHeader('Content-Length', result.content.length);
      response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Content-Disposition', 'inline; filename="trip-cover.jpg"');
      response.end(result.content);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, write);
    } finally { this.active--; request.off('aborted', cancel); response.off('close', cancel); }
  }
}
