import type { FinanceV1 } from '@wolfari/contracts/grpc';

export type RefundRow = {
  id: string;
  fund_id: string;
  member_user_id: string;
  amount: string;
  status: string;
  reason: string;
  requested_by_user_id: string;
  holder_reported_at: Date | string | null;
  confirmed_by_user_id: string | null;
  confirmed_at: Date | string | null;
  cancelled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  nonreceipt_confirmed_at: Date | string | null;
  reversal_consented_at: Date | string | null;
  reversal_requested_at: Date | string | null;
  reversal_reason: string | null;
  cancelled_reason: string | null;
};
function timestamp(value: Date | string) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error('Invalid refund timestamp');
  const seconds = Math.floor(ms / 1000);
  return { seconds: String(seconds), nanos: (ms - seconds * 1000) * 1000000 };
}
const optionalTimestamp = (value: Date | string | null) =>
  value === null ? undefined : timestamp(value);
export function refundResponse(row: RefundRow, financeVersion: number): FinanceV1.RefundView {
  return {
    id: row.id,
    fund_id: row.fund_id,
    member_user_id: row.member_user_id,
    amount: row.amount,
    status: row.status,
    reason: row.reason,
    holder_reported_at: optionalTimestamp(row.holder_reported_at),
    confirmed_at: optionalTimestamp(row.confirmed_at),
    nonreceipt_confirmed_at: optionalTimestamp(row.nonreceipt_confirmed_at),
    reversal_requested_at: optionalTimestamp(row.reversal_requested_at),
    reversal_consented_at: optionalTimestamp(row.reversal_consented_at),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
    version: row.version,
    finance_version: financeVersion,
  };
}
