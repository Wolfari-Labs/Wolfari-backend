import { Client, credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import { loadSync, type MethodDefinition, type ServiceDefinition } from '@grpc/proto-loader';
import { GRPC_LOADER_OPTIONS, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail, grpcFailure, isLoopbackGrpcTarget, responseRecord } from './trip-http';

const service = loadSync(PROTO_PATHS.travel, GRPC_LOADER_OPTIONS)['wolfari.travel.v1.TravelService'] as ServiceDefinition;
const ROUTE = /^\/api\/v1\/travel\/poi-images\/([0-9a-f]{64})\/(320|640|1280)\.webp$/;
export const POI_IMAGE_PREFIX = '/api/v1/travel/poi-images';
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Public URLs and credits for a place's hero photo (POI-IMAGES). Paths are relative to the
 * Gateway origin; clients prefix their API host. Absent or malformed → null.
 */
export function publicPlaceImage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const row = responseRecord(value);
  const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
  const sha = text('sha256');
  if (!SHA256.test(sha) || !text('attribution') || !text('license') || !/^https:\/\//.test(text('source_url'))) return null;
  const size = (key: string) => (typeof row[key] === 'number' && Number.isInteger(row[key]) && (row[key] as number) > 0 ? row[key] : null);
  return {
    url: `${POI_IMAGE_PREFIX}/${sha}/1280.webp`,
    thumbnail_url: `${POI_IMAGE_PREFIX}/${sha}/640.webp`,
    small_url: `${POI_IMAGE_PREFIX}/${sha}/320.webp`,
    width: size('width'),
    height: size('height'),
    author: text('author') || null,
    license: text('license'),
    license_url: /^https?:\/\//.test(text('license_url')) ? text('license_url') : null,
    source_url: text('source_url'),
    attribution: text('attribution'),
    source: text('source') || null,
    is_placeholder: false,
  };
}

/**
 * GET /api/v1/travel/poi-images/{sha256}/{320|640|1280}.webp — licensed, public photos.
 * No session: images must load in <img>/<Image> without headers. Content-addressed, so they are
 * cached for a year; a taken-down photo answers 404 at the next miss.
 */
type ImageCall = (input: { sha256: string; width: number }) => Promise<Record<string, unknown>>;
export class PoiImageHttp {
  private client?: Client;
  private active = 0;
  /** `call` is injectable for tests; production uses the Travel gRPC client. */
  constructor(private readonly call: ImageCall = (input) => this.grpc(input)) {}
  matches(request: IncomingMessage & { originalUrl?: string }) {
    try {
      return new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname.startsWith(`${POI_IMAGE_PREFIX}/`);
    } catch {
      return false;
    }
  }
  async handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
    const route = ROUTE.exec(url.pathname);
    if (!route || (request.method !== 'GET' && request.method !== 'HEAD') || url.search) {
      response.setHeader('Cache-Control', 'no-store');
      return fail(response, 404, 'RESOURCE_NOT_FOUND');
    }
    if (this.active >= 8) {
      response.setHeader('Cache-Control', 'no-store');
      return fail(response, 503, 'SERVICE_UNAVAILABLE', { retryable: true });
    }
    this.active++;
    try {
      const result = await this.call({ sha256: route[1], width: Number(route[2]) });
      const content = result.content;
      if (result.mime_type !== 'image/webp' || !Buffer.isBuffer(content) || content.length < 12 || content.length > MAX_BYTES || content.subarray(8, 12).toString('ascii') !== 'WEBP')
        throw new Error('Invalid image response');
      response.statusCode = 200;
      response.setHeader('Content-Type', 'image/webp');
      response.setHeader('Content-Length', content.length);
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      response.setHeader('Cache-Control', 'no-store');
      grpcFailure(response, error, false);
    } finally {
      this.active--;
    }
  }
  private grpc(input: { sha256: string; width: number }): Promise<Record<string, unknown>> {
    const target = process.env.TRAVEL_GRPC_TARGET ?? '127.0.0.1:3203';
    const secret = process.env.GATEWAY_TRAVEL_SECRET ?? '';
    if (!isLoopbackGrpcTarget(target) || secret.length < 32) return Promise.reject(new Error('Travel unavailable'));
    this.client ??= new Client(target, credentials.createInsecure());
    const method = service.GetPoiImage as MethodDefinition<Record<string, unknown>, Record<string, unknown>>;
    const metadata = new Metadata();
    metadata.set('x-caller-service', 'ApiGateway');
    metadata.set('x-service-secret', secret);
    metadata.set('x-correlation-id', randomUUID());
    return new Promise((resolve, reject) =>
      this.client!.makeUnaryRequest(method.path, method.requestSerialize, method.responseDeserialize, input, metadata, { deadline: Date.now() + 5000 },
        (error: ServiceError | null, result?: Record<string, unknown>) => (error ? reject(error) : resolve(result!))),
    );
  }
  close() {
    this.client?.close();
  }
}
