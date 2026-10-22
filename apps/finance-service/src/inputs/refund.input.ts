import { parsePositiveVndAmount } from '../domain/money';
import { FinanceReadError, readUuid, UUID } from '../finance.errors';

export const refundStatuses = [
  'PENDING',
  'HOLDER_REPORTED',
  'CONFIRMED',
  'CANCELLED',
  'REVERSED',
] as const;
export type RefundStatus = (typeof refundStatuses)[number];
export type RefundCreate = {
  memberUserId: string;
  amount: bigint;
  reason: string;
  expectedFinanceVersion: number;
};
export type RefundAction = { expectedVersion: number; expectedFinanceVersion: number };
export type RefundReasonAction = RefundAction & { reason: string };
export type RefundPage = {
  fundId: string;
  limit: number;
  status?: RefundStatus;
  after?: { at: string; id: string };
};

const invalid = (): never => {
  throw new FinanceReadError('VALIDATION_FAILED');
};
function record(value: unknown, allowed: readonly string[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  if (Object.keys(value).some((key) => !allowed.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647)
    return invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000')) return invalid();
  const result = value.trim();
  if (!result || [...result].length > 1024) return invalid();
  return result;
}
function amount(value: unknown): bigint {
  try {
    return parsePositiveVndAmount(value);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid();
    throw error;
  }
}

export function parseCreateRefund(input: unknown): RefundCreate {
  const body = record(input, ['member_user_id', 'amount', 'reason', 'expected_finance_version']);
  return {
    memberUserId: readUuid(body.member_user_id),
    amount: amount(body.amount),
    reason: text(body.reason),
    expectedFinanceVersion: version(body.expected_finance_version),
  };
}
export function parseRefundAction(input: unknown): RefundAction {
  const body = record(input, ['expected_version', 'expected_finance_version']);
  return {
    expectedVersion: version(body.expected_version),
    expectedFinanceVersion: version(body.expected_finance_version),
  };
}
export function parseRefundReasonAction(input: unknown): RefundReasonAction {
  const body = record(input, ['reason', 'expected_version', 'expected_finance_version']);
  return {
    reason: text(body.reason),
    expectedVersion: version(body.expected_version),
    expectedFinanceVersion: version(body.expected_finance_version),
  };
}
function validCursorInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))
    return false;
  const milliseconds = `${value.slice(0, 23)}Z`;
  const parsed = new Date(milliseconds);
  return (
    Number(value.slice(0, 4)) > 0 &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === milliseconds
  );
}
export function refundCursor(
  scope: Pick<RefundPage, 'fundId' | 'status'>,
  after: { at: string; id: string },
) {
  if (!validCursorInstant(after.at) || !UUID.test(after.id))
    throw new Error('Invalid refund cursor row');
  return Buffer.from(
    JSON.stringify([1, scope.fundId, scope.status ?? null, after.at, after.id]),
  ).toString('base64url');
}
export function parseRefundPage(input: {
  fund_id?: unknown;
  limit?: unknown;
  cursor?: unknown;
  status?: unknown;
}): RefundPage {
  const fundId = readUuid(input.fund_id);
  const limit = input.limit === undefined ? 20 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return invalid();
  const status = input.status;
  if (
    status !== undefined &&
    (typeof status !== 'string' || !refundStatuses.includes(status as RefundStatus))
  )
    return invalid();
  const scope = { fundId, status: status as RefundStatus | undefined };
  let after: RefundPage['after'];
  if (input.cursor !== undefined) {
    if (
      typeof input.cursor !== 'string' ||
      !input.cursor ||
      input.cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(input.cursor)
    )
      return invalid();
    try {
      const raw: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (
        !Array.isArray(raw) ||
        raw.length !== 5 ||
        raw[0] !== 1 ||
        raw[1] !== fundId ||
        raw[2] !== (scope.status ?? null) ||
        !validCursorInstant(raw[3]) ||
        typeof raw[4] !== 'string' ||
        !UUID.test(raw[4]) ||
        raw[4] !== raw[4].toLowerCase()
      )
        return invalid();
      after = { at: raw[3], id: raw[4] };
    } catch (error) {
      if (error instanceof FinanceReadError) throw error;
      return invalid();
    }
  }
  return { ...scope, limit, after };
}
