import busboy from 'busboy';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FinanceClient } from './finance-client';
import {
  authenticate,
  ensureQuery,
  fail,
  grpcFailure,
  json,
  RequestError,
  uuid,
  type SessionValidator,
} from './trip-http';

const LIMIT = 10 * 1024 * 1024;
const MIMES = ['image/jpeg', 'image/png', 'application/pdf'];
const KEY = /^funds\/[0-9a-f-]{36}\/receipts\/[0-9a-f-]{36}-[0-9a-f]{64}\.(jpg|png|pdf)$/;
export function receiptRoute(path: string) {
  return /^\/api\/v1\/funds\/([^/]+)\/receipts(\/download)?$/.exec(path);
}

export function receiptMultipart(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<{ content: Buffer; mime_type: string }> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try {
      if (!request.headers['content-type']?.startsWith('multipart/form-data;')) throw new Error();
      parser = busboy({
        headers: request.headers,
        limits: { files: 1, fields: 0, parts: 2, fileSize: LIMIT + 1, headerPairs: 20 },
      });
    } catch {
      reject(new RequestError('Invalid multipart'));
      return;
    }
    let settled = false,
      total = 0,
      found = false,
      mime = '',
      size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      request.off('data', count);
      request.unpipe(parser);
      parser.destroy();
      if (error) {
        request.resume();
        reject(error);
      } else resolve({ content: Buffer.concat(chunks), mime_type: mime });
    };
    const abort = () => finish(new RequestError('Upload cancelled'));
    const count = (chunk: Buffer) => {
      total += chunk.length;
      if (total > LIMIT + 65536) finish(new RequestError('Multipart limit'));
    };
    const timer = setTimeout(() => finish(new RequestError('Upload deadline')), 15000);
    parser.on('error', () => finish(new RequestError('Invalid multipart')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    parser.on('file', (name, stream, info) => {
      found = true;
      mime = info.mimeType;
      stream.on('error', () => finish(new RequestError('Invalid file stream')));
      if (name !== 'file' || !MIMES.includes(mime)) {
        stream.resume();
        finish(new RequestError('Invalid file'));
        return;
      }
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > LIMIT) finish(new RequestError('File limit'));
        else chunks.push(chunk);
      });
      stream.on('limit', () => finish(new RequestError('File limit')));
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit', 'error'] as const)
      parser.on(event, () => finish(new RequestError('Invalid multipart')));
    parser.once('close', () => {
      if (!settled) finish(!found || !size ? new RequestError('Missing file') : undefined);
    });
    request.on('data', count);
    request.pipe(parser);
  });
}

export class FinanceReceiptHttp {
  private active = 0;
  constructor(
    private readonly validateSession: SessionValidator,
    private readonly client: Pick<FinanceClient, 'callFile' | 'close'> = new FinanceClient(
      process.env.FINANCE_GRPC_TARGET ?? '127.0.0.1:3204',
      process.env.GATEWAY_FINANCE_SECRET ?? '',
    ),
  ) {}
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    route: RegExpExecArray,
  ) {
    const upload = !route[2];
    if (request.method !== (upload ? 'POST' : 'GET'))
      return fail(response, 404, 'RESOURCE_NOT_FOUND');
    if (this.active >= 2) return fail(response, 503, 'SERVICE_UNAVAILABLE');
    this.active++;
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      const auth = await authenticate(request, response, this.validateSession, upload);
      if (!auth) return;
      if (!uuid.test(route[1]!)) throw new RequestError('Invalid Fund');
      const fund = route[1]!.toLowerCase();
      ensureQuery(url, upload ? [] : ['object_key']);
      const key = url.searchParams.get('object_key');
      if (
        !upload &&
        (!key ||
          !KEY.test(key) ||
          request.headers['transfer-encoding'] ||
          (request.headers['content-length'] !== undefined &&
            request.headers['content-length'] !== '0'))
      )
        throw new RequestError('Invalid download');
      const body = upload
        ? await receiptMultipart(request, cancellation.signal)
        : { object_key: key };
      const result = await this.client.callFile(
        upload ? 'UploadFinanceReceipt' : 'DownloadFinanceReceipt',
        { ...body, fund_id: fund, actor_user_id: auth.actorUserId },
        auth.correlationId,
        cancellation.signal,
      );
      if (
        typeof result.object_key !== 'string' ||
        !KEY.test(result.object_key) ||
        !result.object_key.startsWith(`funds/${fund}/receipts/`) ||
        !MIMES.includes(String(result.mime_type)) ||
        !Number.isInteger(result.size_bytes) ||
        Number(result.size_bytes) < 1 ||
        Number(result.size_bytes) > LIMIT
      )
        throw new Error('Invalid file response');
      if (upload)
        return json(response, 201, {
          data: {
            object_key: result.object_key,
            mime_type: result.mime_type,
            size_bytes: result.size_bytes,
          },
          meta: { correlation_id: auth.correlationId },
        });
      if (
        result.object_key !== key ||
        !Buffer.isBuffer(result.content) ||
        result.content.length !== result.size_bytes
      )
        throw new Error('Invalid download response');
      response.writeHead(200, {
        'Content-Type': String(result.mime_type),
        'Content-Length': result.content.length,
        'Content-Disposition': `attachment; filename="receipt.${{ 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' }[String(result.mime_type)]}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(result.content);
    } catch (error) {
      if (response.destroyed) return;
      response.setHeader('Cache-Control', 'private, no-store');
      if (error instanceof RequestError) {
        response.setHeader('Connection', 'close');
        return fail(response, 400, 'VALIDATION_FAILED');
      }
      // Upload has no idempotency-key contract; retries may create another temporary file.
      return grpcFailure(response, error, false);
    } finally {
      this.active--;
      request.off('aborted', abort);
      response.off('close', abort);
    }
  }
  close() {
    this.client.close();
  }
}
