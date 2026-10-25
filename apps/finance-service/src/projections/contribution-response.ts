import type { FinanceV1 } from '@wolfari/contracts/grpc';

export type NewContributionRequestRow = {
  id: string;
  fund_id: string;
  title: string;
  created_by_user_id: string;
  created_at: Date;
  due_at: Date | null;
  note: string | null;
};
const timestamp = (date: Date | string) => {
  const ms = new Date(date).getTime();
  if (!Number.isFinite(ms)) throw new Error('Invalid contribution timestamp');
  const seconds = Math.floor(ms / 1000);
  return { seconds: String(seconds), nanos: (ms - seconds * 1000) * 1000000 };
};
/** Public metadata for a newly issued request. No recipient configuration or evidence. */
export function contributionRequestResponse(
  row: NewContributionRequestRow,
): FinanceV1.ContributionRequestView {
  return {
    id: row.id,
    fund_id: row.fund_id,
    title: row.title,
    status: 'OPEN',
    version: 1,
    created_by_user_id: row.created_by_user_id,
    created_at: timestamp(row.created_at),
    due_at: row.due_at === null ? undefined : timestamp(row.due_at),
    note: row.note ?? undefined,
    contributions: [],
  };
}

export type ContributionReadRow = {
  id: string;
  request_id: string;
  fund_id: string;
  member_user_id: string;
  amount: string;
  status: string;
  self_contribution: boolean;
  version: number;
  member_reported_at: string | Date | null;
  confirmed_at: string | Date | null;
  confirmed_by_user_id: string | null;
  waived_reason: string | null;
  cancelled_reason: string | null;
};
export type ContributionRequestReadRow = Omit<
  NewContributionRequestRow,
  'created_at' | 'due_at'
> & {
  created_at: Date | string;
  due_at: Date | string | null;
  closed_at: Date | string | null;
  amount_per_member: string | null;
  status: string;
  version: number;
  contributions: ContributionReadRow[];
};
export function contributionResponse(
  row: ContributionReadRow,
  financeVersion: number,
): FinanceV1.ContributionView {
  return {
    id: row.id,
    request_id: row.request_id,
    fund_id: row.fund_id,
    member_user_id: row.member_user_id,
    amount: row.amount,
    status: row.status,
    self_contribution: row.self_contribution,
    version: row.version,
    finance_version: financeVersion,
    member_reported_at:
      row.member_reported_at === null ? undefined : timestamp(row.member_reported_at),
    confirmed_at: row.confirmed_at === null ? undefined : timestamp(row.confirmed_at),
    confirmed_by_user_id: row.confirmed_by_user_id ?? undefined,
    waived_reason: row.waived_reason ?? undefined,
    cancelled_reason: row.cancelled_reason ?? undefined,
  };
}
export function contributionRequestReadResponse(
  row: ContributionRequestReadRow,
  financeVersion: number,
): FinanceV1.ContributionRequestView {
  return {
    id: row.id,
    fund_id: row.fund_id,
    title: row.title,
    status: row.status,
    version: row.version,
    created_by_user_id: row.created_by_user_id,
    created_at: timestamp(row.created_at),
    due_at: row.due_at === null ? undefined : timestamp(row.due_at),
    note: row.note ?? undefined,
    closed_at: row.closed_at === null ? undefined : timestamp(row.closed_at),
    amount_per_member: row.amount_per_member ?? undefined,
    finance_version: financeVersion,
    contributions: row.contributions.map((c) => contributionResponse(c, financeVersion)),
  };
}
