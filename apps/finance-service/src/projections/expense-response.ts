import type { FinanceV1 } from '@wolfari/contracts/grpc';

export type ExpenseRow = {
  id: string;
  fund_id: string;
  title: string;
  description: string | null;
  amount: string;
  category: string | null;
  receipt_object_key: string | null;
  status: string;
  created_by_user_id: string;
  submitted_at: Date | string | null;
  paid_at: Date | string | null;
  payment_method: string | null;
  paid_by_user_id: string | null;
  confirmed_at: Date | string | null;
  confirmed_by_user_id: string | null;
  rejected_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};
function timestamp(value: Date | string) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error('Invalid expense timestamp');
  const seconds = Math.floor(ms / 1000);
  return { seconds: String(seconds), nanos: (ms - seconds * 1000) * 1000000 };
}
export function expenseResponse(row: ExpenseRow, financeVersion: number): FinanceV1.ExpenseView {
  return {
    id: row.id,
    fund_id: row.fund_id,
    title: row.title,
    description: row.description ?? undefined,
    amount: row.amount,
    category: row.category ?? undefined,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    receipt_available: row.receipt_object_key !== null,
    submitted_at: row.submitted_at === null ? undefined : timestamp(row.submitted_at),
    paid_at: row.paid_at === null ? undefined : timestamp(row.paid_at),
    payment_method: row.payment_method ?? undefined,
    paid_by_user_id: row.paid_by_user_id ?? undefined,
    confirmed_at: row.confirmed_at === null ? undefined : timestamp(row.confirmed_at),
    confirmed_by_user_id: row.confirmed_by_user_id ?? undefined,
    rejected_reason: row.rejected_reason ?? undefined,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
    version: row.version,
    finance_version: financeVersion,
  };
}
