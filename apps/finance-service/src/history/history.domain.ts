import { FinanceReadError, readUuid, UUID } from '../finance.errors';
import type { FinanceV1 } from '@wolfari/contracts/grpc';

// Member history is a business projection, not a raw support/technical audit feed.
// New writer actions require an explicit privacy review before joining this list.
export const HISTORY_ACTIONS = [
  'ENABLE_FUND',
  'UPDATE_FUND_BUDGET',
  'CREATE_PAYMENT_DESTINATION',
  'UPDATE_PAYMENT_DESTINATION',
  'CONFIRM_PAYMENT_DESTINATION',
  'CREATE_CONTRIBUTION_REQUEST',
  'UPDATE_CONTRIBUTION_REQUEST',
  'UPDATE_CONTRIBUTION_AMOUNT',
  'WAIVE_CONTRIBUTION',
  'CANCEL_CONTRIBUTION',
  'REPORT_TRANSFER',
  'CONFIRM_RECEIVED',
  'REJECT_TRANSFER',
  'REVERSE_CONTRIBUTION',
  'CREATE_EXPENSE',
  'UPDATE_EXPENSE',
  'DELETE_EXPENSE',
  'SUBMIT_EXPENSE',
  'WITHDRAW_EXPENSE',
  'CONFIRM_EXPENSE',
  'REJECT_EXPENSE',
  'REVERSE_EXPENSE',
  'CREATE_FINANCIAL_NOTE',
  'UPDATE_FINANCIAL_NOTE',
  'DELETE_FINANCIAL_NOTE',
  'CREATE_REFUND',
  'REPORT_REFUND_PAID',
  'CONFIRM_REFUND_RECEIVED',
  'CONFIRM_REFUND_NONRECEIPT',
  'CANCEL_REFUND',
  'REQUEST_REFUND_REVERSAL',
  'CONSENT_REFUND_REVERSAL',
  'REVERSE_REFUND',
  'CREATE_CLOSURE',
  'CONFIRM_CLOSURE',
  'CANCEL_CLOSURE',
  'REMIND_CLOSURE',
  'CREATE_PAYMENT_ATTEMPT',
  'RECONCILE_PAYMENT_ATTEMPT',
  'RESOLVE_PAYMENT_EXCEPTION',
  'CONFIRM_PROVIDER_PAYMENT',
  'LEAVE_MEMBER',
  'REMOVE_MEMBER',
] as const;

export type HistoryPage = {
  fundId: string;
  actorId: string;
  limit: number;
  before?: { at: string; id: string };
};
export type HistoryRow = {
  id: string;
  fund_id: string;
  actor_user_id: string | null;
  system_actor: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  from_version: number | null;
  to_version: number | null;
  reason: string | null;
  reason_oversized: boolean;
  occurred_at: string;
  correlation_id: string;
};

export function historyInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))
    return false;
  const ms = value.slice(0, 23) + 'Z';
  const date = new Date(ms);
  return (
    Number(value.slice(0, 4)) > 0 && Number.isFinite(date.getTime()) && date.toISOString() === ms
  );
}

export function historyCursor(
  page: Pick<HistoryPage, 'fundId' | 'actorId'>,
  row: { at: string; id: string },
) {
  if (!historyInstant(row.at) || !UUID.test(row.id) || row.id !== row.id.toLowerCase())
    throw new Error('Invalid history boundary');
  return Buffer.from(
    JSON.stringify(['finance-history-v1', page.fundId, page.actorId, row.at, row.id]),
  ).toString('base64url');
}

export function historyPage(input: FinanceV1.ListFundHistoryRequest): HistoryPage {
  const page: HistoryPage = {
    fundId: readUuid(input.fund_id),
    actorId: readUuid(input.actor_user_id),
    limit: input.limit ?? 20,
  };
  const invalid = (): never => {
    throw new FinanceReadError('VALIDATION_FAILED');
  };
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) invalid();
  if (input.cursor !== undefined) {
    try {
      if (
        typeof input.cursor !== 'string' ||
        input.cursor.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(input.cursor)
      )
        return invalid();
      const value: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (
        !Array.isArray(value) ||
        value.length !== 5 ||
        !historyInstant(value[3]) ||
        typeof value[4] !== 'string'
      )
        return invalid();
      page.before = { at: value[3], id: value[4] };
      if (historyCursor(page, page.before) !== input.cursor) invalid();
    } catch {
      invalid();
    }
  }
  return page;
}

export function historyResponse(row: HistoryRow, fundId: string): FinanceV1.FundAuditEntry {
  const id = (value: string) => {
    if (typeof value !== 'string' || !UUID.test(value))
      throw new Error('Invalid history identifier');
    return value;
  };
  const version = (value: number | null) => {
    if (value === null) return undefined;
    if (!Number.isInteger(value) || value < 1 || value > 2147483647)
      throw new Error('Invalid history version');
    return value;
  };
  if (
    row.fund_id !== fundId ||
    !HISTORY_ACTIONS.some((action) => action === row.action) ||
    !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(row.entity_type) ||
    (row.system_actor !== null &&
      !['MOMO_IPN', 'MOMO_RECONCILIATION'].includes(row.system_actor)) ||
    row.reason_oversized !== false ||
    (row.reason !== null && (typeof row.reason !== 'string' || row.reason.length > 2000)) ||
    !historyInstant(row.occurred_at)
  )
    throw new Error('Invalid stored history');
  const milliseconds = new Date(row.occurred_at).getTime();
  return {
    id: id(row.id),
    fund_id: id(row.fund_id),
    actor_user_id: row.actor_user_id === null ? undefined : id(row.actor_user_id),
    system_actor: row.system_actor ?? undefined,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id === null ? undefined : id(row.entity_id),
    from_version: version(row.from_version),
    to_version: version(row.to_version),
    reason: row.reason ?? undefined,
    correlation_id: id(row.correlation_id),
    occurred_at: {
      seconds: String(Math.floor(milliseconds / 1000)),
      nanos: Number(row.occurred_at.slice(20, 26)) * 1000,
    },
  };
}
