export type NotificationErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'SERVICE_UNAVAILABLE';

export class NotificationError extends Error {
  constructor(
    public readonly code: NotificationErrorCode,
    public readonly details: { current_version?: number } | null = null,
  ) {
    super(code);
  }
}

export function notificationFail(
  code: NotificationErrorCode,
  details: { current_version?: number } | null = null,
): never {
  throw new NotificationError(code, details);
}
