import { FinanceV1 } from '@wolfari/contracts/grpc';
import type { LedgerRecord } from '../repositories/ledger.repository';
import { assertVndAmount } from '../domain/money';
import { UUID } from '../finance.errors';

/** Public ledger fields only. Invalid stored values must never become client validation errors. */
export function ledgerResponse(row: LedgerRecord, fundId: string): FinanceV1.LedgerEntryView {
  const id = (value: string) => {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid stored ledger ID');
    return value;
  };
  const optionalId = (value: string | null) => (value === null ? undefined : id(value));
  assertVndAmount(row.amount);
  assertVndAmount(row.balanceAfter);
  assertVndAmount(row.sequence);
  if (
    row.fundId !== fundId ||
    row.amount === 0n ||
    row.sequence === 0n ||
    !['IN', 'OUT'].includes(row.direction) ||
    !['CONTRIBUTION', 'EXPENSE', 'REFUND', 'REVERSAL'].includes(row.transactionType) ||
    (row.reason !== null && typeof row.reason !== 'string') ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  )
    throw new Error('Invalid stored ledger entry');
  const ms = row.createdAt.getTime();
  return {
    id: id(row.id),
    fund_id: id(row.fundId),
    sequence: row.sequence.toString(),
    direction:
      row.direction === 'IN'
        ? FinanceV1.LedgerDirection.LEDGER_DIRECTION_IN
        : FinanceV1.LedgerDirection.LEDGER_DIRECTION_OUT,
    transaction_type: row.transactionType,
    amount: row.amount.toString(),
    balance_after: row.balanceAfter.toString(),
    contribution_id: optionalId(row.contributionId),
    expense_id: optionalId(row.expenseId),
    refund_id: optionalId(row.refundId),
    reversal_of_id: optionalId(row.reversalOfId),
    actor_user_id: optionalId(row.actorUserId),
    reason: row.reason ?? undefined,
    created_at: {
      seconds: String(Math.floor(ms / 1000)),
      nanos: (((ms % 1000) + 1000) % 1000) * 1000000,
    },
  };
}
