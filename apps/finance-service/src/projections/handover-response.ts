import type { FinanceV1 } from '@wolfari/contracts/grpc';
export type HandoverRow = {
  id: string;
  fund_id: string;
  old_holder_user_id: string;
  new_holder_user_id: string;
  nominated_by_user_id: string;
  status: string;
  version: number;
  snapshot_finance_version: number | null;
  snapshot: FinanceV1.HolderHandoverSnapshot | null;
  accepted_at: Date | string | null;
  old_holder_confirmed_at: Date | string | null;
  new_holder_confirmed_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  cancellation_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  snapshot_stale_override?: boolean;
};
function timestamp(value: Date | string | null) {
  if (value === null) return undefined;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error('Invalid handover timestamp');
  const seconds = Math.floor(ms / 1000);
  return { seconds: String(seconds), nanos: (ms - seconds * 1000) * 1000000 };
}
export function handoverResponse(
  row: HandoverRow,
  financeVersion: number,
): FinanceV1.HolderHandoverView {
  const stale =
    row.status === 'ACCEPTED' &&
    (row.snapshot_finance_version !== financeVersion || row.snapshot_stale_override === true);
  return {
    id: row.id,
    fund_id: row.fund_id,
    old_holder_user_id: row.old_holder_user_id,
    new_holder_user_id: row.new_holder_user_id,
    nominated_by_user_id: row.nominated_by_user_id,
    status: row.status,
    version: row.version,
    finance_version: financeVersion,
    snapshot_finance_version: row.snapshot_finance_version ?? undefined,
    snapshot: row.snapshot ?? undefined,
    snapshot_stale: stale,
    accepted_at: timestamp(row.accepted_at),
    old_holder_confirmed_at: stale ? undefined : timestamp(row.old_holder_confirmed_at),
    new_holder_confirmed_at: stale ? undefined : timestamp(row.new_holder_confirmed_at),
    completed_at: timestamp(row.completed_at),
    cancelled_at: timestamp(row.cancelled_at),
    cancellation_reason: row.cancellation_reason ?? undefined,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}
