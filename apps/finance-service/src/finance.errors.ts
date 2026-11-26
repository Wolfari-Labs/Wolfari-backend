export type FinanceReadErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'SERVICE_UNAVAILABLE'
  | 'PAYMENT_PROVIDER_NOT_CONFIGURED'
  | 'STATE_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'FINANCE_OBLIGATION_BLOCKED';
/**
 * Machine-readable sub-reason for a 409 STATE_CONFLICT, returned as error.details.reason.
 * The HTTP status and top-level code stay unchanged; clients may branch on the reason
 * and must treat an absent or unknown reason as a generic conflict.
 */
export const FINANCE_CONFLICT_REASONS = [
  'FUND_NOT_OPEN',
  'CLOSURE_PENDING',
  'FUND_ALREADY_EXISTS',
  'HOLDER_NOT_ACTIVE',
  'MEMBER_NOT_ACTIVE',
  'TRIP_ARCHIVED',
  'INSUFFICIENT_AVAILABLE_BALANCE',
  'HANDOVER_IN_PROGRESS',
  'INVALID_TRANSITION',
  /** payOS would pay into an account other than this contribution's destination. */
  'PAYMENT_PROVIDER_ACCOUNT_MISMATCH',
] as const;
export type FinanceConflictReason = (typeof FINANCE_CONFLICT_REASONS)[number];
export function isFinanceConflictReason(value: unknown): value is FinanceConflictReason {
  return FINANCE_CONFLICT_REASONS.includes(value as FinanceConflictReason);
}
/** A Fund that is not OPEN is either waiting for closure confirmations or already closed. */
export function fundNotOpenReason(status: string): FinanceConflictReason {
  return status === 'CLOSING' ? 'CLOSURE_PENDING' : 'FUND_NOT_OPEN';
}
export class FinanceReadError extends Error {
  constructor(
    public readonly code: FinanceReadErrorCode,
    public readonly reason?: FinanceConflictReason,
  ) {
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
