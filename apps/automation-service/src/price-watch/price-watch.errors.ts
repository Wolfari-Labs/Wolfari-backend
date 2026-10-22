export type PriceWatchErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'VERSION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SERVICE_UNAVAILABLE';

export class PriceWatchError extends Error {
  constructor(
    public readonly code: PriceWatchErrorCode,
    public readonly details: { current_version?: number } | null = null,
  ) {
    super(code);
  }
}

export function priceWatchFail(
  code: PriceWatchErrorCode,
  details: { current_version?: number } | null = null,
): never {
  throw new PriceWatchError(code, details);
}
