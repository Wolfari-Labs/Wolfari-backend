import { assertVndAmount } from './money';

export type RefundForBalance = Readonly<{
  amount: bigint;
  status: 'PENDING' | 'HOLDER_REPORTED' | 'CONFIRMED' | 'CANCELLED' | 'REVERSED';
}>;

export type FundBalance = Readonly<{
  currentBalance: bigint;
  reservedRefund: bigint;
  availableBalance: bigint;
}>;

export class InsufficientAvailableBalanceError extends Error {
  readonly code = 'INSUFFICIENT_AVAILABLE_BALANCE';

  constructor() {
    super('The amount exceeds the available fund balance');
    this.name = 'InsufficientAvailableBalanceError';
  }
}

function assertPositiveAmount(amount: bigint): void {
  assertVndAmount(amount);
  if (amount === 0n) {
    throw new RangeError('The amount must be greater than zero');
  }
}

/** R08: current balance already includes all confirmed ledger entries. */
export function calculateFundBalance(
  currentBalance: bigint,
  refunds: readonly RefundForBalance[],
): FundBalance {
  assertVndAmount(currentBalance);
  let reservedRefund = 0n;

  for (const refund of refunds) {
    assertPositiveAmount(refund.amount);
    switch (refund.status) {
      case 'PENDING':
      case 'HOLDER_REPORTED':
        reservedRefund += refund.amount;
        break;
      case 'CONFIRMED':
      case 'CANCELLED':
      case 'REVERSED':
        break;
      default:
        throw new TypeError('Unknown refund status');
    }
  }

  return calculateFundBalanceFromReservation(currentBalance, reservedRefund);
}

/** Apply the same balance invariant to an exact reservation total read from the database. */
export function calculateFundBalanceFromReservation(
  currentBalance: bigint,
  reservedRefund: bigint,
): FundBalance {
  assertVndAmount(currentBalance);
  assertVndAmount(reservedRefund);
  if (reservedRefund > currentBalance) {
    throw new RangeError('Reserved refunds cannot exceed the current fund balance');
  }

  return {
    currentBalance,
    reservedRefund,
    availableBalance: currentBalance - reservedRefund,
  };
}

/**
 * Pure check for an expense, a new refund reservation or reversal of an IN entry.
 * The caller must read these values and persist the change under the same Fund lock.
 * Confirming an existing refund instead releases its reservation with the OUT entry.
 */
export function assertCanSpend(
  currentBalance: bigint,
  refunds: readonly RefundForBalance[],
  amount: bigint,
): void {
  assertPositiveAmount(amount);
  const balance = calculateFundBalance(currentBalance, refunds);
  if (amount > balance.availableBalance) {
    throw new InsufficientAvailableBalanceError();
  }
}
