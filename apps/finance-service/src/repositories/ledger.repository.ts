import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { LedgerDirection } from '../domain/ledger-balance';
import { parsePositiveVndAmount, parseVndAmount } from '../domain/money';

/** Internal record; bigint/Date fields must be mapped before an API response. */
export type LedgerRecord = Readonly<{
  id: string;
  fundId: string;
  sequence: bigint;
  direction: LedgerDirection;
  transactionType: 'CONTRIBUTION' | 'EXPENSE' | 'REFUND' | 'REVERSAL';
  amount: bigint;
  balanceAfter: bigint;
  contributionId: string | null;
  expenseId: string | null;
  refundId: string | null;
  reversalOfId: string | null;
  actorUserId: string | null;
  reason: string | null;
  createdAt: Date;
}>;

type LedgerRow = {
  id: string;
  fund_id: string;
  sequence: string;
  direction: string;
  transaction_type: LedgerRecord['transactionType'];
  amount: string;
  balance_after: string;
  contribution_id: string | null;
  expense_id: string | null;
  refund_id: string | null;
  reversal_of_id: string | null;
  actor_user_id: string | null;
  reason: string | null;
  created_at: Date;
};

export type LedgerPage = Readonly<{
  items: readonly LedgerRecord[];
  nextCursor: string | null;
}>;

function sequence(value: unknown): bigint {
  if (typeof value !== 'string' || !value || value[0] === '0' || /[^0-9]/u.test(value)) {
    throw new TypeError('Ledger sequence must be a positive decimal string');
  }
  const parsed = BigInt(value);
  if (parsed > 9223372036854775807n) throw new RangeError('Ledger sequence exceeds int8');
  return parsed;
}

function readCursor(value: unknown, fundId: string): string | null {
  if (value === undefined) return null;
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error();
    }
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== 1 || parsed[1] !== fundId) {
      throw new Error();
    }
    return sequence(parsed[2]).toString();
  } catch {
    throw new TypeError('Invalid ledger cursor for this Fund');
  }
}

function mapEntry(row: LedgerRow): LedgerRecord {
  // PostgreSQL char(3) pads IN with a trailing space.
  const direction = row.direction.trimEnd();
  if (direction !== 'IN' && direction !== 'OUT') {
    throw new TypeError('Invalid stored ledger direction');
  }
  return {
    id: row.id,
    fundId: row.fund_id,
    sequence: sequence(row.sequence),
    direction,
    transactionType: row.transaction_type,
    amount: parsePositiveVndAmount(row.amount),
    balanceAfter: parseVndAmount(row.balance_after),
    contributionId: row.contribution_id,
    expenseId: row.expense_id,
    refundId: row.refund_id,
    reversalOfId: row.reversal_of_id,
    actorUserId: row.actor_user_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

@Injectable()
export class LedgerRepository {
  constructor(@Inject(DatabaseProvider) private readonly db: Pick<DatabaseProvider, 'query'>) {}

  /**
   * Caller resolves a validated Fund UUID and checks current Trip access on every page.
   * Cursor is navigation data, not authorization. Unknown Fund and empty ledger both return [].
   * Descending keyset paging excludes newer appends; it is not an export snapshot or write lock.
   */
  async listByFundId(
    fundId: string,
    options: Readonly<{ limit?: number; cursor?: string }> = {},
  ): Promise<LedgerPage> {
    const limit = options.limit === undefined ? 20 : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Ledger page limit must be an integer from 1 to 100');
    }
    const before = readCursor(options.cursor, fundId);
    const { rows } = await this.db.query<LedgerRow>(
      `SELECT id, fund_id, sequence, direction, transaction_type, amount, balance_after,
              contribution_id, expense_id, refund_id, reversal_of_id, actor_user_id,
              reason, created_at
         FROM public.fund_transactions
        WHERE fund_id = $1 AND ($2::bigint IS NULL OR sequence < $2::bigint)
        ORDER BY sequence DESC
        LIMIT $3`,
      [fundId, before, limit + 1],
    );
    const items = rows.slice(0, limit).map(mapEntry);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([1, fundId, last.sequence.toString()])).toString('base64url')
          : null,
    };
  }
}
