import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import { parseVndAmount } from '../domain/money';

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
}
