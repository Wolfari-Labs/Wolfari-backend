import busboy from 'busboy';
import type { IncomingMessage } from 'node:http';
import { RequestError } from './trip-http';

export function readMultipartFile(
  request: IncomingMessage,
  signal: AbortSignal,
  options: { maxBytes: number; mimeTypes: readonly string[] },
): Promise<{ content: Buffer; mime_type: string }> {
  const LIMIT = options.maxBytes, MIMES = options.mimeTypes;
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
