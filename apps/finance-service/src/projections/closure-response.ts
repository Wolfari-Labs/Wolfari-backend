import type { FinanceV1 } from '@wolfari/contracts/grpc';

export type ClosureRow = {
  id: string;
  fund_id: string;
  requested_by_user_id: string;
  status: string;
  snapshot_finance_version: number;
  snapshot_schema_version: number;
  snapshot_json: unknown;
  snapshot_hash: string;
  requested_at: Date | string;
  cancelled_at: Date | string | null;
  cancelled_reason: string | null;
  closed_at: Date | string | null;
};
export type ConfirmationRow = { user_id: string; confirmed_at: Date | string | null };
const timestamp = (value: Date | string) => {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new Error('Invalid closure timestamp');
  return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
};
export function closureResponse(
  row: ClosureRow,
  confirmations: readonly ConfirmationRow[],
  financeVersion: number,
): FinanceV1.ClosureView {
  return {
    id: row.id,
    fund_id: row.fund_id,
    requested_by_user_id: row.requested_by_user_id,
    status: row.status,
    snapshot_finance_version: row.snapshot_finance_version,
    snapshot_schema_version: row.snapshot_schema_version,
    snapshot_json: JSON.stringify(row.snapshot_json),
    snapshot_hash: row.snapshot_hash,
    requested_at: timestamp(row.requested_at),
    cancelled_at: row.cancelled_at === null ? undefined : timestamp(row.cancelled_at),
    cancelled_reason: row.cancelled_reason ?? undefined,
    closed_at: row.closed_at === null ? undefined : timestamp(row.closed_at),
    confirmations: confirmations.map((item) => ({
      user_id: item.user_id,
      confirmed_at: item.confirmed_at === null ? undefined : timestamp(item.confirmed_at),
    })),
    finance_version: financeVersion,
  };
}
