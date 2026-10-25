import { FinanceReadError, readUuid, UUID } from '../finance.errors';

export type FinancialNoteWrite = {
  description: string;
  amount: bigint | null;
  payerUserId: string | null;
  expectedFinanceVersion: number;
};
export type FinancialNotePatch = {
  description?: string;
  amount?: bigint | null;
  payerUserId?: string | null;
  expectedVersion: number;
  expectedFinanceVersion: number;
};
export type FinancialNoteAction = { expectedVersion: number; expectedFinanceVersion: number };
export type FinancialNotePage = {
  fundId: string;
  limit: number;
  after?: { at: string; id: string };
};

const invalid = (): never => {
  throw new FinanceReadError('VALIDATION_FAILED');
};
function record(value: unknown, allowed: readonly string[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (Object.keys(value).some((key) => !allowed.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function description(value: unknown) {
  if (typeof value !== 'string' || value.includes('\u0000')) return invalid();
  const result = value.trim();
  if (!result) return invalid();
  return result;
}
function amount(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return invalid();
  const result = BigInt(value);
  if (result > 9223372036854775807n) return invalid();
  return result;
}
function version(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647)
    return invalid();
  return value;
}
function payer(value: unknown): string | null {
  return value === undefined || value === null ? null : readUuid(value);
}

export function parseCreateFinancialNote(input: unknown): FinancialNoteWrite {
  const body = record(input, ['description', 'amount', 'payer_user_id', 'expected_finance_version']);
  return {
    description: description(body.description),
    amount: amount(body.amount),
    payerUserId: payer(body.payer_user_id),
    expectedFinanceVersion: version(body.expected_finance_version),
  };
}
export function parseUpdateFinancialNote(input: unknown): FinancialNotePatch {
  const body = record(input, [
    'description',
    'amount',
    'payer_user_id',
    'expected_version',
    'expected_finance_version',
  ]);
  if (!['description', 'amount', 'payer_user_id'].some((key) => Object.hasOwn(body, key)))
    return invalid();
  const result: FinancialNotePatch = {
    expectedVersion: version(body.expected_version),
    expectedFinanceVersion: version(body.expected_finance_version),
  };
  if (Object.hasOwn(body, 'description')) result.description = description(body.description);
  if (Object.hasOwn(body, 'amount')) result.amount = amount(body.amount);
  if (Object.hasOwn(body, 'payer_user_id')) result.payerUserId = payer(body.payer_user_id);
  return result;
}
export function parseFinancialNoteAction(input: unknown): FinancialNoteAction {
  const body = record(input, ['expected_version', 'expected_finance_version']);
  return {
    expectedVersion: version(body.expected_version),
    expectedFinanceVersion: version(body.expected_finance_version),
  };
}
function validInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))
    return false;
  const millis = value.slice(0, 23) + 'Z';
  return Number.isFinite(new Date(millis).getTime()) && new Date(millis).toISOString() === millis;
}
export function financialNoteCursor(scope: Pick<FinancialNotePage, 'fundId'>, after: { at: string; id: string }) {
  if (!validInstant(after.at) || !UUID.test(after.id)) throw new Error('Invalid note cursor row');
  return Buffer.from(JSON.stringify([1, scope.fundId, after.at, after.id])).toString('base64url');
}
export function parseFinancialNotePage(input: { fund_id?: unknown; limit?: unknown; cursor?: unknown }): FinancialNotePage {
  const fundId = readUuid(input.fund_id);
  const limit = input.limit === undefined ? 20 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) return invalid();
  let after: FinancialNotePage['after'];
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) return invalid();
    try {
      const raw: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(raw) || raw.length !== 4 || raw[0] !== 1 || raw[1] !== fundId || !validInstant(raw[2]) || typeof raw[3] !== 'string' || !UUID.test(raw[3]) || raw[3] !== raw[3].toLowerCase()) return invalid();
      after = { at: raw[2], id: raw[3] };
    } catch (error) {
      if (error instanceof FinanceReadError) throw error;
      invalid();
    }
  }
  return { fundId, limit, after };
}
