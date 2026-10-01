import { assertCanSpend, calculateFundBalance, type RefundForBalance } from './fund-balance';
import { calculateBalanceAfterEntry, type LedgerDirection } from './ledger-balance';

/** A projection of a persisted ledger entry, not a request DTO. */
export type LedgerEntryForReversal = Readonly<{
  id: string;
  direction: LedgerDirection;
  amount: bigint;
  reversalOfId: string | null;
}>;

export type LedgerReversalContext = Readonly<{
  currentBalance: bigint;
  refunds: readonly RefundForBalance[];
  hasExistingReversal: boolean;
}>;

export type LedgerReversalEffect = Readonly<{
  reversalOfId: string;
  direction: LedgerDirection;
  amount: bigint;
  balanceAfter: bigint;
}>;

export class LedgerReversalNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerReversalNotAllowedError';
  }
}

/**
 * R08: calculate an equal-amount, opposite-direction reversal without changing the original.
 * The caller must load the original and context from the same Fund under its lock.
 * hasExistingReversal comes from stored ledger data, never from the client.
 * This does not validate actor rights, Fund/source lifecycle, reason or refund consent.
 * Persist the new entry and balance atomically; a DB unique constraint must also prevent
 * duplicate reversal_of_id. A pure calculation cannot prevent concurrent duplicate writes.
 */
export function calculateLedgerReversal(
  original: LedgerEntryForReversal,
  context: LedgerReversalContext,
): LedgerReversalEffect {
  if (original.reversalOfId !== null) {
    throw new LedgerReversalNotAllowedError('A reversal entry cannot be reversed');
  }
  if (context.hasExistingReversal) {
    throw new LedgerReversalNotAllowedError('The original entry already has a reversal');
  }

  let direction: LedgerDirection;
  switch (original.direction) {
    case 'IN':
      direction = 'OUT';
      assertCanSpend(context.currentBalance, context.refunds, original.amount);
      break;
    case 'OUT':
      direction = 'IN';
      calculateFundBalance(context.currentBalance, context.refunds);
      break;
    default:
      throw new TypeError('Unknown original ledger direction');
  }

  return {
    reversalOfId: original.id,
    direction,
    amount: original.amount,
    balanceAfter: calculateBalanceAfterEntry(context.currentBalance, direction, original.amount),
  };
}
