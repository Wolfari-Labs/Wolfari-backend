/** Tolerated client/server clock difference for user-entered instants. */
export const COMMAND_CLOCK_SKEW_MS = 5 * 60_000;

export class CommandTimingError extends Error {
  constructor(public readonly field: 'due_at' | 'paid_at') {
    super(`Invalid ${field} for the current time`);
    this.name = 'CommandTimingError';
  }
}

type TimedCommand = Readonly<{ scope: string; body?: unknown }>;

function instant(body: unknown, key: 'dueAt' | 'paidAt'): Date | null {
  if (!body || typeof body !== 'object' || !Object.hasOwn(body, key)) return null;
  const value = (body as Record<string, unknown>)[key];
  return value instanceof Date ? value : null;
}

/**
 * Rules that depend on "now" and therefore apply to NEW commands only. The coordinator calls
 * this after idempotent replay resolution, so retrying a stored command never starts failing
 * just because time passed. A payment cannot be recorded as made in the future, and a new
 * contribution request cannot already be overdue. Updating an existing due date is not checked.
 */
export function assertCommandTiming(command: TimedCommand, now = Date.now()): void {
  switch (command.scope) {
    case 'CREATE_CONTRIBUTION_REQUEST': {
      const dueAt = instant(command.body, 'dueAt');
      if (dueAt && dueAt.getTime() < now - COMMAND_CLOCK_SKEW_MS)
        throw new CommandTimingError('due_at');
      return;
    }
    case 'CREATE_EXPENSE':
    case 'UPDATE_EXPENSE':
    case 'CONFIRM_EXPENSE': {
      const paidAt = instant(command.body, 'paidAt');
      if (paidAt && paidAt.getTime() > now + COMMAND_CLOCK_SKEW_MS)
        throw new CommandTimingError('paid_at');
      return;
    }
    default:
      return;
  }
}
