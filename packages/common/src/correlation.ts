import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const storage = new AsyncLocalStorage<string>();
const validCorrelationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeCorrelationId(value: unknown): string {
  return typeof value === 'string' && validCorrelationId.test(value) ? value : randomUUID();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore();
}

export class CorrelationMiddleware {
  use(request: IncomingMessage, response: ServerResponse, next: () => void): void {
    const correlationId = normalizeCorrelationId(request.headers['x-correlation-id']);
    response.setHeader('x-correlation-id', correlationId);
    storage.run(correlationId, next);
  }
}
