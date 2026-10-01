import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { ContributionStatus } from '../domain/contribution-transition';
import { parsePositiveVndAmount } from '../domain/money';

export type ContributionRequestScope = Readonly<{ fundId: string; requestId: string }>;
export type ContributionScope = ContributionRequestScope & Readonly<{ contributionId: string }>;

/** Internal persistence records, not API DTOs or locked command context. */
export type ContributionRequestRecord = Readonly<{
  id: string;
  fundId: string;
  title: string;
  amountPerMember: bigint | null;
  dueAt: Date | null;
  note: string | null;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  version: number;
  createdByUserId: string;
  createdAt: Date;
  closedAt: Date | null;
}>;

export type ContributionRecord = Readonly<{
  id: string;
  requestId: string;
  fundId: string;
  memberUserId: string;
  amount: bigint;
  status: ContributionStatus;
  version: number;
  selfContribution: boolean;
  memberReportedAt: Date | null;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
  waivedReason: string | null;
  cancelledReason: string | null;
  rejectedReason: string | null;
  waivedAt: Date | null;
  cancelledAt: Date | null;
  reversedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type RequestRow = {
  id: string;
  fund_id: string;
  title: string;
  amount_per_member: string | null;
  due_at: Date | null;
  note: string | null;
  status: ContributionRequestRecord['status'];
  version: number;
  created_by_user_id: string;
  created_at: Date;
  closed_at: Date | null;
};
type ContributionRow = {
  id: string;
  request_id: string;
  fund_id: string;
  member_user_id: string;
  amount: string;
  status: ContributionStatus;
  version: number;
  self_contribution: boolean;
  member_reported_at: Date | null;
  confirmed_by_user_id: string | null;
  confirmed_at: Date | null;
  waived_reason: string | null;
  cancelled_reason: string | null;
  rejected_reason: string | null;
  waived_at: Date | null;
  cancelled_at: Date | null;
  reversed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

@Injectable()
export class ContributionRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'query'>) {}

  /** Caller validates UUIDs, resolves ownership and checks current Trip access. Wrong scope returns null. */
  async findRequestById(
    scope: ContributionRequestScope,
  ): Promise<ContributionRequestRecord | null> {
    const { rows } = await this.db.query<RequestRow>(
      `SELECT id, fund_id, title, amount_per_member, due_at, note, status, version,
              created_by_user_id, created_at, closed_at
         FROM public.contribution_requests
        WHERE fund_id = $1 AND id = $2`,
      [scope.fundId, scope.requestId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      fundId: row.fund_id,
      title: row.title,
      amountPerMember:
        row.amount_per_member === null ? null : parsePositiveVndAmount(row.amount_per_member),
      dueAt: row.due_at,
      note: row.note,
      status: row.status,
      version: row.version,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      closedAt: row.closed_at,
    };
  }

  /**
   * Requires all three IDs to match. No destination snapshot or evidence object key is selected.
   * Reads history regardless of status. No row lock, actor authorization or finance_version here;
   * separate calls are separate snapshots, not a context safe for writes or an export snapshot.
   */
  async findById(scope: ContributionScope): Promise<ContributionRecord | null> {
    const { rows } = await this.db.query<ContributionRow>(
      `SELECT id, request_id, fund_id, member_user_id, amount, status, version,
              self_contribution, member_reported_at, confirmed_by_user_id, confirmed_at,
              waived_reason, cancelled_reason, rejected_reason, waived_at, cancelled_at,
              reversed_at, created_at, updated_at
         FROM public.contributions
        WHERE fund_id = $1 AND request_id = $2 AND id = $3`,
      [scope.fundId, scope.requestId, scope.contributionId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      requestId: row.request_id,
      fundId: row.fund_id,
      memberUserId: row.member_user_id,
      amount: parsePositiveVndAmount(row.amount),
      status: row.status,
      version: row.version,
      selfContribution: row.self_contribution,
      memberReportedAt: row.member_reported_at,
      confirmedByUserId: row.confirmed_by_user_id,
      confirmedAt: row.confirmed_at,
      waivedReason: row.waived_reason,
      cancelledReason: row.cancelled_reason,
      rejectedReason: row.rejected_reason,
      waivedAt: row.waived_at,
      cancelledAt: row.cancelled_at,
      reversedAt: row.reversed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
