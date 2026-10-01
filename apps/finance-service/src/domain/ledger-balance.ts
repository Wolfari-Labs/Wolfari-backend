import { assertVndAmount } from './money';

export type LedgerDirection = 'IN' | 'OUT';

/**
 * Calculate balance_after for a single ledger entry; this does not authorize a payment.
 * For expenses and reversals of IN, call assertCanSpend with the current reservations first.
 * Refund confirmation instead records OUT and releases that refund's reservation together.
 * The caller must validate the source, permissions and lifecycle, then persist the entry
 * and balance in the same transaction under the Fund lock, with source uniqueness enforced.
 */
export function calculateBalanceAfterEntry(
  currentBalance: bigint,
  direction: LedgerDirection,
  amount: bigint,
): bigint {
  assertVndAmount(currentBalance);
  assertVndAmount(amount);
  if (amount === 0n) {
    throw new RangeError('Ledger entry amount must be greater than zero');
  }

  let balanceAfter: bigint;
  switch (direction) {
    case 'IN':
      balanceAfter = currentBalance + amount;
      break;
    case 'OUT':
      balanceAfter = currentBalance - amount;
      break;
    default:
      throw new TypeError('Unknown ledger direction');
  }

  assertVndAmount(balanceAfter);
  return balanceAfter;
}
