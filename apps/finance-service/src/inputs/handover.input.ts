import { FinanceReadError, readUuid } from '../finance.errors';

export type HandoverCreate = { newHolderUserId: string; expectedFinanceVersion: number };
export type HandoverAction = {
  expectedVersion: number;
  expectedFinanceVersion: number;
  expectedSnapshotFinanceVersion?: number;
  reason?: string;
};
const invalid = (): never => {
  throw new FinanceReadError('VALIDATION_FAILED');
};
function version(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483647) return invalid();
  return Number(value);
}
export function parseHandoverCreate(input: {
  new_holder_user_id?: unknown;
  expected_finance_version?: unknown;
}): HandoverCreate {
  return {
    newHolderUserId: readUuid(input.new_holder_user_id),
    expectedFinanceVersion: version(input.expected_finance_version),
  };
}
export function parseHandoverAction(
  input: {
    expected_version?: unknown;
    expected_finance_version?: unknown;
    expected_snapshot_finance_version?: unknown;
    reason?: unknown;
  },
  kind: 'accept' | 'refresh' | 'confirm' | 'cancel',
): HandoverAction {
  const body: HandoverAction = {
    expectedVersion: version(input.expected_version),
    expectedFinanceVersion: version(input.expected_finance_version),
  };
  if (kind === 'confirm')
    body.expectedSnapshotFinanceVersion = version(input.expected_snapshot_finance_version);
  if (kind === 'cancel') {
    if (
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.includes('\u0000') ||
      [...input.reason.trim()].length > 1024
    )
      return invalid();
    body.reason = input.reason.trim();
  }
  return body;
}
