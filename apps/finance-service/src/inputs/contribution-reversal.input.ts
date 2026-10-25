export type ContributionReversalInput = Readonly<{
  reason: string;
  expectedVersion: number;
  expectedFinanceVersion: number;
}>;

export class ContributionReversalInputError extends Error {
  constructor(public readonly field: string) {
    super(`Invalid contribution reversal field: ${field}`);
    this.name = 'ContributionReversalInputError';
  }
}

const invalid = (field: string): never => {
  throw new ContributionReversalInputError(field);
};

export function parseContributionReversalInput(input: unknown): ContributionReversalInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('body');
  const body = input as Record<string, unknown>;
  if (
    Object.keys(body).some(
      (key) => !['reason', 'expected_version', 'expected_finance_version'].includes(key),
    )
  )
    return invalid('body');
  const version = (field: string) => {
    const value = body[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647)
      return invalid(field);
    return value;
  };
  if (typeof body.reason !== 'string' || body.reason.includes('\0')) return invalid('reason');
  const reason = body.reason.trim();
  if (!reason || [...reason].length > 1024) return invalid('reason');
  return {
    reason,
    expectedVersion: version('expected_version'),
    expectedFinanceVersion: version('expected_finance_version'),
  };
}
