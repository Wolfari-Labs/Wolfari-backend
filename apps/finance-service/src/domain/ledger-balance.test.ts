import { describe, expect, it } from 'vitest';
import {
  assertCanSpend,
  calculateFundBalance,
  InsufficientAvailableBalanceError,
  type RefundForBalance,
} from './fund-balance';
import { calculateBalanceAfterEntry, type LedgerDirection } from './ledger-balance';

describe('ledger balance arithmetic', () => {
  it('starts a fund at zero and applies confirmed receipts and expenses in order', () => {
    const firstReceipt = calculateBalanceAfterEntry(0n, 'IN', 300_000n);
    const secondReceipt = calculateBalanceAfterEntry(firstReceipt, 'IN', 200_000n);
    const afterExpense = calculateBalanceAfterEntry(secondReceipt, 'OUT', 120_000n);

    expect(firstReceipt).toBe(300_000n);
    expect(secondReceipt).toBe(500_000n);
    expect(afterExpense).toBe(380_000n);
  });

  it('allows an OUT entry to bring the balance exactly to zero', () => {
    expect(calculateBalanceAfterEntry(300_000n, 'OUT', 300_000n)).toBe(0n);
  });

  it('rejects an OUT entry that would make the balance negative', () => {
    expect(() => calculateBalanceAfterEntry(300_000n, 'OUT', 300_001n)).toThrow(RangeError);
    expect(() => calculateBalanceAfterEntry(0n, 'OUT', 1n)).toThrow(RangeError);
  });

  it('preserves one-dong changes above the JavaScript number precision limit', () => {
    expect(calculateBalanceAfterEntry(9_007_199_254_740_992n, 'IN', 1n)).toBe(
      9_007_199_254_740_993n,
    );
    expect(calculateBalanceAfterEntry(9_007_199_254_740_994n, 'OUT', 1n)).toBe(
      9_007_199_254_740_993n,
    );
  });

  it('accepts the PostgreSQL bigint maximum but rejects overflow from addition', () => {
    expect(calculateBalanceAfterEntry(9_223_372_036_854_775_806n, 'IN', 1n)).toBe(
      9_223_372_036_854_775_807n,
    );
    expect(() => calculateBalanceAfterEntry(9_223_372_036_854_775_807n, 'IN', 1n)).toThrow(
      RangeError,
    );
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n])(
    'rejects invalid entry amount %s in both directions',
    (amount) => {
      expect(() => calculateBalanceAfterEntry(300_000n, 'IN', amount)).toThrow(RangeError);
      expect(() => calculateBalanceAfterEntry(300_000n, 'OUT', amount)).toThrow(RangeError);
    },
  );

  it.each([-1n, 9_223_372_036_854_775_808n])(
    'rejects invalid opening balance %s even if the result would be in range',
    (balance) => {
      const direction = balance < 0n ? 'IN' : 'OUT';
      expect(() => calculateBalanceAfterEntry(balance, direction, 1n)).toThrow(RangeError);
    },
  );

  it('rejects an unknown direction instead of treating it as OUT', () => {
    expect(() => calculateBalanceAfterEntry(300_000n, 'SIDEWAYS' as LedgerDirection, 1n)).toThrow(
      TypeError,
    );
  });
});

describe('ledger arithmetic with refund reservations', () => {
  it('checks available balance before applying an expense OUT', () => {
    const refunds: RefundForBalance[] = [{ amount: 100_000n, status: 'PENDING' }];

    expect(() => assertCanSpend(300_000n, refunds, 200_001n)).toThrow(
      InsufficientAvailableBalanceError,
    );
    assertCanSpend(300_000n, refunds, 200_000n);
    const balanceAfter = calculateBalanceAfterEntry(300_000n, 'OUT', 200_000n);
    expect(calculateFundBalance(balanceAfter, refunds)).toEqual({
      currentBalance: 100_000n,
      reservedRefund: 100_000n,
      availableBalance: 0n,
    });
  });

  it('confirms an existing refund using its reservation while keeping other refunds reserved', () => {
    const before = calculateFundBalance(300_000n, [
      { amount: 200_000n, status: 'HOLDER_REPORTED' },
      { amount: 50_000n, status: 'PENDING' },
    ]);

    // Simulate the values a future transaction must persist together.
    // A refund already reserved does not require another 200000 of available balance.
    const balanceAfter = calculateBalanceAfterEntry(before.currentBalance, 'OUT', 200_000n);
    const after = calculateFundBalance(balanceAfter, [
      { amount: 200_000n, status: 'CONFIRMED' },
      { amount: 50_000n, status: 'PENDING' },
    ]);

    expect(after).toEqual({
      currentBalance: 100_000n,
      reservedRefund: 50_000n,
      availableBalance: 50_000n,
    });
    expect(after.availableBalance).toBe(before.availableBalance);
  });

  it('checks available balance when an IN entry is offset by an OUT reversal', () => {
    const refunds: RefundForBalance[] = [{ amount: 100_000n, status: 'PENDING' }];
    const balance = calculateBalanceAfterEntry(100_000n, 'IN', 200_000n);

    assertCanSpend(balance, refunds, 200_000n);
    const afterReversal = calculateBalanceAfterEntry(balance, 'OUT', 200_000n);
    expect(afterReversal).toBe(100_000n);
    expect(calculateFundBalance(afterReversal, refunds).availableBalance).toBe(0n);
    // Reversal identity, consent and uniqueness belong to the future use case/DB.
  });
});
