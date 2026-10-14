import type { ManualContributionCommand } from '../domain/contribution-transition';

export type ManualContributionInput = Readonly<{
  command: ManualContributionCommand;
  // Present only when a new report supplies evidence. Absence is not a deletion instruction.
  evidenceObjectKey?: string;
}>;

export class ManualContributionInputError extends Error {
  constructor(public readonly field: string) {
    super(`Invalid manual contribution field: ${field}`);
    this.name = 'ManualContributionInputError';
  }
}

function invalid(field: string): never {
  throw new ManualContributionInputError(field);
}

function allowedFields(action: ManualContributionCommand['action']): readonly string[] {
  const versions = ['expected_version', 'expected_finance_version'];
  switch (action) {
    case 'REPORT_TRANSFER':
      return [...versions, 'evidence_object_key'];
    case 'CONFIRM_RECEIVED':
      return versions;
    case 'REJECT_TRANSFER':
      return [...versions, 'reason'];
    default:
      return invalid('action');
  }
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('body');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid('body');
  if (Object.keys(value).some((key) => !allowed.includes(key))) return invalid('body');
  return value as Record<string, unknown>;
}

function version(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (
    !Object.hasOwn(body, field) ||
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 2147483647
  ) {
    return invalid(field);
  }
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000')) {
    return invalid(field);
  }
  return value;
}

/**
 * Parse only the JSON BODY of API087–089. The adapter selects the action from the route,
 * never from client input. No actor, amount, state, ownership, auth or idempotency checks.
 * Evidence stays outside the domain command for a future use case to authorize the file;
 * do not log this private key, infer its storage format, or clear old evidence if omitted.
 * A future writer still obtains the Trip guard, resolves replay, reads locked state and
 * commits the transition/ledger/receipt/audit/outbox atomically. This result is not a row patch.
 */
export function parseManualContributionInput(
  action: ManualContributionCommand['action'],
  input: unknown,
): ManualContributionInput {
  const body = object(input, allowedFields(action));
  const versions = {
    expectedVersion: version(body, 'expected_version'),
    expectedFinanceVersion: version(body, 'expected_finance_version'),
  };
  switch (action) {
    case 'REPORT_TRANSFER':
      return {
        command: { action, ...versions },
        ...(Object.hasOwn(body, 'evidence_object_key')
          ? { evidenceObjectKey: text(body.evidence_object_key, 'evidence_object_key') }
          : {}),
      };
    case 'CONFIRM_RECEIVED':
      return { command: { action, ...versions } };
    case 'REJECT_TRANSFER':
      if (!Object.hasOwn(body, 'reason')) return invalid('reason');
      return { command: { action, ...versions, reason: text(body.reason, 'reason') } };
  }
}
