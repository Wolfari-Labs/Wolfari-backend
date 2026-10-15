import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { ContributionStatus } from '../domain/contribution-transition';
import { parsePositiveVndAmount } from '../domain/money';

export type ContributionRequestScope = Readonly<{ fundId: string; requestId: string }>;
export type ContributionScope = ContributionRequestScope & Readonly<{ contributionId: string }>;

export type ContributionStatusTotal = Readonly<{ count: bigint; amount: bigint }>;

/** Current stored allocations, not ledger totals, bank receipts or an API contract. */
export type ContributionRequestCollectionSummary = Readonly<{
  fundId: string;
  requestId: string;
  requestStatus: ContributionRequestRecord['status'];
  requestVersion: number;
  total: ContributionStatusTotal;
  byStatus: Readonly<Record<ContributionStatus, ContributionStatusTotal>>;
}>;

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

type CollectionSummaryRow = {
  fund_id: string;
  request_id: string;
  request_status: ContributionRequestRecord['status'];
  request_version: number;
  contribution_status: ContributionStatus | null;
  contribution_count: string;
  contribution_amount: string;
};

// SUM(bigint) is numeric in PostgreSQL. A summary may exceed int8 even when every
// allocation is valid Money; preserve that total without casting or truncating.
function parseAggregate(value: string): bigint {
  if (typeof value !== 'string' || value.length === 0 || /[^0-9]/u.test(value)) {
    throw new TypeError('Contribution aggregate must be an unsigned decimal string');
  }
  return BigInt(value);
}

@Injectable()
export class ContributionRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'query'>) {}

  /**
   * One statement snapshot scoped to an existing Fund/request, including empty requests.
   * Caller validates IDs and current Trip access. No lock, write authorization or
   * finance_version is provided. TRANSFER_REPORTED is not received money; CONFIRMED
   * is not available Fund balance. REVERSED stays separate, not a new obligation.
   * All totals are internal bigint aggregates and must not use the int8 Money formatter.
   */
  async findRequestCollectionSummary(
    scope: ContributionRequestScope,
  ): Promise<ContributionRequestCollectionSummary | null> {
    const { rows } = await this.db.query<CollectionSummaryRow>(
      `SELECT r.fund_id, r.id AS request_id, r.status AS request_status,
              r.version AS request_version, c.status AS contribution_status,
              COUNT(c.id)::text AS contribution_count,
              COALESCE(SUM(c.amount), 0)::text AS contribution_amount
         FROM public.contribution_requests r
         LEFT JOIN public.contributions c ON c.request_id = r.id AND c.fund_id = r.fund_id
        WHERE r.fund_id = $1 AND r.id = $2
        GROUP BY r.fund_id, r.id, r.status, r.version, c.status`,
      [scope.fundId, scope.requestId],
    );
    const first = rows[0];
    if (!first) return null;

    const byStatus: Record<ContributionStatus, ContributionStatusTotal> = {
      PENDING: { count: 0n, amount: 0n },
      TRANSFER_REPORTED: { count: 0n, amount: 0n },
      CONFIRMED: { count: 0n, amount: 0n },
      WAIVED: { count: 0n, amount: 0n },
      CANCELLED: { count: 0n, amount: 0n },
      REVERSED: { count: 0n, amount: 0n },
    };
    let count = 0n;
    let amount = 0n;
    for (const row of rows) {
      const bucket = {
        count: parseAggregate(row.contribution_count),
        amount: parseAggregate(row.contribution_amount),
      };
      if (row.contribution_status === null) {
        if (bucket.count !== 0n || bucket.amount !== 0n) {
          throw new TypeError('Empty contribution summary must have zero totals');
        }
        continue;
      }
      if (!Object.hasOwn(byStatus, row.contribution_status)) {
        throw new TypeError('Unknown stored contribution status');
      }
      byStatus[row.contribution_status] = bucket;
      count += bucket.count;
      amount += bucket.amount;
    }
    return {
      fundId: first.fund_id,
      requestId: first.request_id,
      requestStatus: first.request_status,
      requestVersion: first.request_version,
      total: { count, amount },
      byStatus,
    };
  }

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
