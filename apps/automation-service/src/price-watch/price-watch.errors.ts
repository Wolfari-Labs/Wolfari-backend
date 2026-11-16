export type PriceWatchErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'VERSION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'SERVICE_UNAVAILABLE';

export type PriceWatchErrorDetails = { current_version?: number; reason?: string };

export class PriceWatchError extends Error {
  constructor(
    public readonly code: PriceWatchErrorCode,
    public readonly details: PriceWatchErrorDetails | null = null,
  ) {
    super(code);
  }
}

export function priceWatchFail(
  code: PriceWatchErrorCode,
  details: PriceWatchErrorDetails | null = null,
): never {
  throw new PriceWatchError(code, details);
}
