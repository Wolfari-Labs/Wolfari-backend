import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TripClient } from './trip-client';
import { readMultipartFile } from './multipart-upload';
import { authenticate, ensureQuery, fail, grpcFailure, json, RequestError, uuid, type SessionValidator } from './trip-http';

const LIMIT = 2 * 1024 * 1024;
type ImageRoute = { tripId: string; dressCodeId?: string };
export function dressImageRoute(path: string): ImageRoute | undefined {
  const upload = /^\/api\/v1\/trips\/([^/]+)\/dress-code-images$/.exec(path);
  if (upload) return { tripId: upload[1]! };
  const read = /^\/api\/v1\/trips\/([^/]+)\/dress-codes\/([^/]+)\/reference-image$/.exec(path);
  if (read) return { tripId: read[1]!, dressCodeId: read[2]! };
}
export class DressCodeImageHttp {
  private active = 0;
  constructor(private readonly validate: SessionValidator, private readonly client: Pick<TripClient, 'call'>) {}
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, route: ImageRoute) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const upload = !route.dressCodeId;
    if (request.method !== (upload ? 'POST' : 'GET')) return fail(response, 404, 'RESOURCE_NOT_FOUND');
    if (this.active >= 2) return fail(response, 503, 'SERVICE_UNAVAILABLE');
    this.active++;
    const abort = new AbortController(), cancel = () => abort.abort();
    request.once('aborted', cancel); response.once('close', cancel);
    try {
      const auth = await authenticate(request, response, this.validate, upload);
      if (!auth) return;
      if (!uuid.test(route.tripId) || (route.dressCodeId && !uuid.test(route.dressCodeId))) throw new RequestError('Invalid scope');
      ensureQuery(url, []);
      if (!upload && (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0'))) throw new RequestError('Unexpected body');
      const file = upload ? await readMultipartFile(request, abort.signal, { maxBytes: LIMIT, mimeTypes: ['image/jpeg', 'image/png'] }) : {};
      const result = await this.client.call<Record<string, unknown>, Record<string, unknown>>(upload ? 'UploadDressCodeImage' : 'GetDressCodeImage', {
        ...file, actor_user_id: auth.actorUserId, trip_id: route.tripId.toLowerCase(), ...(route.dressCodeId ? { dress_code_id: route.dressCodeId.toLowerCase() } : {}),
      }, auth.correlationId);
      if (abort.signal.aborted) return;
      if (result.mime_type !== 'image/jpeg' || !Number.isInteger(result.size_bytes) || Number(result.size_bytes) < 1 || Number(result.size_bytes) > LIMIT) throw Error('Invalid image response');
      if (upload) {
        if (typeof result.image_id !== 'string' || !uuid.test(result.image_id)) throw Error('Invalid image ID');
        return json(response, 201, { data: { image_id: result.image_id, mime_type: result.mime_type, size_bytes: result.size_bytes }, meta: { correlation_id: auth.correlationId } });
      }
      if (!Buffer.isBuffer(result.content) || result.content.length !== result.size_bytes) throw Error('Invalid image bytes');
      response.statusCode = 200;
      response.setHeader('Content-Type', 'image/jpeg'); response.setHeader('Content-Length', result.content.length);
      response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Content-Disposition', 'inline; filename="dress-code-reference.jpg"');
      response.end(result.content);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, error, upload);
    } finally { this.active--; request.off('aborted', cancel); response.off('close', cancel); }
  }
}
