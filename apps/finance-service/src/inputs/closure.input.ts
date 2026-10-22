import { FinanceReadError, readUuid } from '../finance.errors';

export type ClosurePage = Readonly<{
  fundId: string;
  limit: number;
  after?: Readonly<{ at: string; id: string }>;
}>;
export type CreateClosureInput = Readonly<{ expectedFinanceVersion: number }>;
export type ConfirmClosureInput = Readonly<{ snapshotHash: string }>;
export type CancelClosureInput = Readonly<{ reason: string }>;

const fail = (): never => {
  throw new FinanceReadError('VALIDATION_FAILED');
};
const int32 = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483647) return fail();
  return Number(value);
};
const object = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) return fail();
  return row;
};
const text = (value: unknown, max: number) => {
  if (typeof value !== 'string' || value.includes('\0')) return fail();
  const result = value.trim();
  if (!result || [...result].length > max) return fail();
  return result;
};

export function parseCreateClosure(value: unknown): CreateClosureInput {
  const row = object(value, ['expected_finance_version']);
  return { expectedFinanceVersion: int32(row.expected_finance_version) };
}
export function parseConfirmClosure(value: unknown): ConfirmClosureInput {
  const row = object(value, ['snapshot_hash']);
  if (typeof row.snapshot_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.snapshot_hash))
    return fail();
  return { snapshotHash: row.snapshot_hash };
}
export function parseCancelClosure(value: unknown): CancelClosureInput {
  const row = object(value, ['reason']);
  return { reason: text(row.reason, 1024) };
}
export function parseRemindClosure(value: unknown): Record<string, never> {
  object(value, []);
  return {};
}

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (value: string) => {
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) return fail();
  try {
    const row = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (Object.keys(row).sort().join(',') !== 'at,fund_id,id') return fail();
    const at = String(row.at);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at)) return fail();
    return { fundId: readUuid(row.fund_id), at, id: readUuid(row.id) };
  } catch {
    return fail();
  }
};
export function parseClosurePage(value: {
  fund_id?: unknown;
  limit?: unknown;
  cursor?: unknown;
}): ClosurePage {
  const fundId = readUuid(value.fund_id);
  const limit = value.limit === undefined ? 20 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail();
  if (value.cursor === undefined) return { fundId, limit };
  if (typeof value.cursor !== 'string') return fail();
  const after = decode(value.cursor);
  if (after.fundId !== fundId) return fail();
  return { fundId, limit, after: { at: after.at, id: after.id } };
}
export const closureCursor = (page: Pick<ClosurePage, 'fundId'>, row: { at: string; id: string }) =>
  encode({ fund_id: page.fundId, at: row.at, id: row.id });
