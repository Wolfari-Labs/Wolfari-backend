export type FinanceReadErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'SERVICE_UNAVAILABLE'
  | 'STATE_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT';
export class FinanceReadError extends Error {
  constructor(public readonly code: FinanceReadErrorCode) {
    super(code);
    this.name = 'FinanceReadError';
  }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function readUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new FinanceReadError('VALIDATION_FAILED');
  return value.toLowerCase();
}
export function loopbackTarget(value: string): boolean {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(value);
  return Boolean(match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535);
}
