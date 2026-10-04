export interface TripErrorDetails {
  invitation_version?: number;
  plan_version?: number;
  membership_revision?: number;
  export_revision?: number;
}

export class TripError extends Error {
  constructor(
    public readonly code:
      | 'VALIDATION_FAILED'
      | 'RESOURCE_NOT_FOUND'
      | 'PERMISSION_DENIED'
      | 'VERSION_CONFLICT'
      | 'STATE_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT',
    public readonly status: number,
    public readonly details: TripErrorDetails | null = null,
  ) {
    super(code);
  }
}

export const fail = (
  code: TripError['code'],
  status: number,
  details: TripErrorDetails | null = null,
): never => {
  throw new TripError(code, status, details);
};
