import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { parseVndAmount } from '../domain/money';
import { calculateFundBalanceFromReservation, type FundBalance } from '../domain/fund-balance';

/** Internal persistence snapshot, not an API response or a locked write context. */
export type FundRecord = Readonly<{
  id: string;
  tripId: string;
  holderUserId: string;
  currency: 'VND';
  budgetAmount: bigint | null;
  currentBalance: bigint;
  status: 'OPEN' | 'CLOSING' | 'CLOSED';
  financeVersion: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}>;

// PostgreSQL int8 is returned as a string by the shared pg provider.
type FundRow = {
  id: string;
  trip_id: string;
  holder_user_id: string;
  currency: FundRecord['currency'];
  budget_amount: string | null;
  current_balance: string;
  status: FundRecord['status'];
  finance_version: number;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
};

export type FundSummary = FundRecord & FundBalance;

function mapFund(row: FundRow): FundRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    holderUserId: row.holder_user_id,
    currency: row.currency,
    budgetAmount: row.budget_amount === null ? null : parseVndAmount(row.budget_amount),
    currentBalance: parseVndAmount(row.current_balance),
    status: row.status,
    financeVersion: row.finance_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

@Injectable()
export class FundRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'query'>) {}

  /**
   * Caller supplies a validated Trip UUID and enforces access before exposing data.
   * Reads one snapshot without a row lock; do not use it as a balance/write guard.
   * A missing Fund returns null. Database and money-mapping errors are propagated.
   */
  async findByTripId(tripId: string): Promise<FundRecord | null> {
    const { rows } = await this.db.query<FundRow>(
      `SELECT id, trip_id, holder_user_id, currency, budget_amount, current_balance,
              status, finance_version, created_at, updated_at, closed_at
         FROM public.funds
        WHERE trip_id = $1`,
      [tripId],
    );
    const row = rows[0];
    if (!row) return null;

    return mapFund(row);
  }

  /**
   * One SELECT reads Fund and reservations from the same statement snapshot.
   * Same caller authorization requirements as findByTripId; not a locked write guard.
   */
  async findSummaryByTripId(tripId: string): Promise<FundSummary | null> {
    const { rows } = await this.db.query<FundRow & { reserved_refund: string }>(
      `SELECT f.id, f.trip_id, f.holder_user_id, f.currency, f.budget_amount,
              f.current_balance, f.status, f.finance_version,
              f.created_at, f.updated_at, f.closed_at,
              (SELECT COALESCE(SUM(r.amount), 0)::text
                 FROM public.fund_refunds r
                WHERE r.fund_id = f.id
                  AND r.status IN ('PENDING', 'HOLDER_REPORTED')) AS reserved_refund
         FROM public.funds f
        WHERE f.trip_id = $1`,
      [tripId],
    );
    const row = rows[0];
    if (!row) return null;
    const fund = mapFund(row);
    return {
      ...fund,
      ...calculateFundBalanceFromReservation(
        fund.currentBalance,
        parseVndAmount(row.reserved_refund),
      ),
    };
  }
}
