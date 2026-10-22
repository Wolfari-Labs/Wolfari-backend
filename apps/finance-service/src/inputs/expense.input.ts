import { FinanceReadError, readUuid, UUID } from '../finance.errors';
import { parsePositiveVndAmount } from '../domain/money';

export const expenseStatuses = ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'REJECTED', 'REVERSED'] as const;
export type ExpenseStatus = (typeof expenseStatuses)[number];
export type ExpenseWrite = {
  title: string;
  description: string | null;
  amount: bigint;
  category: string | null;
  receiptObjectKey: string | null;
  paidAt: Date | null;
  paymentMethod: string | null;
  expectedFinanceVersion: number;
};
export type ExpensePatch = {
  title?: string;
  description?: string | null;
  amount?: bigint;
  category?: string | null;
  receiptObjectKey?: string | null;
  paidAt?: Date | null;
  paymentMethod?: string | null;
  expectedVersion: number;
  expectedFinanceVersion: number;
};
export type ExpenseAction = {
  expectedVersion: number;
  expectedFinanceVersion: number;
};
export type ExpensePage = {
  fundId: string;
  limit: number;
  status?: ExpenseStatus;
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
function text(value: unknown, max: number, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || value.includes('\u0000')) return invalid();
  const normalized = value.trim();
  if (!normalized || [...normalized].length > max) return invalid();
  return normalized;
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647)
    return invalid();
  return value;
}
function amount(value: unknown): bigint {
  try {
    return parsePositiveVndAmount(value);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) invalid();
    throw error;
  }
}
function instant(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return invalid();
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) return invalid();
  return result;
}
const writeFields = [
  'title',
  'description',
  'amount',
  'category',
  'receipt_object_key',
  'paid_at',
  'payment_method',
] as const;

export function parseCreateExpense(input: unknown): ExpenseWrite {
  const body = record(input, [...writeFields, 'expected_finance_version']);
  return {
    title: text(body.title, 200)!,
    description: text(body.description, 10000, true),
    amount: amount(body.amount),
    category: text(body.category, 80, true),
    receiptObjectKey: text(body.receipt_object_key, 1024, true),
    paidAt: instant(body.paid_at),
    paymentMethod: text(body.payment_method, 30, true),
    expectedFinanceVersion: version(body.expected_finance_version),
  };
}

export function parseUpdateExpense(input: unknown): ExpensePatch {
  const body = record(input, [...writeFields, 'expected_version', 'expected_finance_version']);
  if (!writeFields.some((field) => Object.hasOwn(body, field))) return invalid();
  const result: ExpensePatch = {
    expectedVersion: version(body.expected_version),
    expectedFinanceVersion: version(body.expected_finance_version),
  };
  if (Object.hasOwn(body, 'title')) result.title = text(body.title, 200)!;
  if (Object.hasOwn(body, 'description')) result.description = text(body.description, 10000, true);
  if (Object.hasOwn(body, 'amount')) result.amount = amount(body.amount);
  if (Object.hasOwn(body, 'category')) result.category = text(body.category, 80, true);
  if (Object.hasOwn(body, 'receipt_object_key'))
    result.receiptObjectKey = text(body.receipt_object_key, 1024, true);
  if (Object.hasOwn(body, 'paid_at')) result.paidAt = instant(body.paid_at);
  if (Object.hasOwn(body, 'payment_method'))
    result.paymentMethod = text(body.payment_method, 30, true);
  return result;
}

export function parseExpenseAction(input: unknown): ExpenseAction {
  const body = record(input, ['expected_version', 'expected_finance_version']);
  return {
    expectedVersion: version(body.expected_version),
    expectedFinanceVersion: version(body.expected_finance_version),
  };
}

function validCursorInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))
    return false;
  const millis = value.slice(0, 23) + 'Z';
  const parsed = new Date(millis);
  return (
    Number(value.slice(0, 4)) > 0 &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === millis
  );
}
export function expenseCursor(
  scope: Pick<ExpensePage, 'fundId' | 'status'>,
  after: { at: string; id: string },
) {
  if (!validCursorInstant(after.at) || !UUID.test(after.id))
    throw new Error('Invalid expense cursor row');
  return Buffer.from(
    JSON.stringify([1, scope.fundId, scope.status ?? null, after.at, after.id]),
  ).toString('base64url');
}
export function parseExpensePage(input: {
  fund_id?: unknown;
  limit?: unknown;
  cursor?: unknown;
  status?: unknown;
}): ExpensePage {
  const fundId = readUuid(input.fund_id);
  const limit = input.limit === undefined ? 20 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return invalid();
  const status = input.status;
  if (
    status !== undefined &&
    (typeof status !== 'string' || !expenseStatuses.includes(status as ExpenseStatus))
  )
    return invalid();
  const scope = { fundId, status: status as ExpenseStatus | undefined };
  let after: ExpensePage['after'];
  if (input.cursor !== undefined) {
    const cursor = input.cursor;
    if (
      typeof cursor !== 'string' ||
      !cursor ||
      cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    )
      return invalid();
    try {
      const raw: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
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
      invalid();
    }
  }
  return { ...scope, limit, after };
}
