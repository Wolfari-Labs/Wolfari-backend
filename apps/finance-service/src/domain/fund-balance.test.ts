import { describe, expect, it } from 'vitest';
import {
  assertCanSpend,
  calculateFundBalance,
  calculateFundBalanceFromReservation,
  InsufficientAvailableBalanceError,
  type RefundForBalance,
} from './fund-balance';

describe('fund balance and refund reservations', () => {
  it('accepts an exact database reservation total, including zero and full reservation', () => {
    expect(calculateFundBalanceFromReservation(0n, 0n).availableBalance).toBe(0n);
    expect(calculateFundBalanceFromReservation(9007199254740993n, 9007199254740992n)).toEqual({
      currentBalance: 9007199254740993n,
      reservedRefund: 9007199254740992n,
      availableBalance: 1n,
    });
    expect(calculateFundBalanceFromReservation(100n, 100n).availableBalance).toBe(0n);
  });

  it.each([-1n, 101n, 9223372036854775808n])('rejects invalid reservation total %s', (reserved) => {
    expect(() => calculateFundBalanceFromReservation(100n, reserved)).toThrow(RangeError);
  });

  it('makes the whole balance available when there are no refunds', () => {
    expect(calculateFundBalance(300_000n, [])).toEqual({
      currentBalance: 300_000n,
      reservedRefund: 0n,
      availableBalance: 300_000n,
    });
    expect(calculateFundBalance(0n, []).availableBalance).toBe(0n);
  });

  it('reserves both pending and holder-reported refunds', () => {
    expect(
      calculateFundBalance(300_000n, [
        { amount: 60_000n, status: 'PENDING' },
        { amount: 40_000n, status: 'HOLDER_REPORTED' },
      ]),
    ).toEqual({
      currentBalance: 300_000n,
      reservedRefund: 100_000n,
      availableBalance: 200_000n,
    });
  });

  it.each(['CONFIRMED', 'CANCELLED', 'REVERSED'] as const)(
    'does not reserve or subtract a %s refund again',
    (status) => {
      expect(calculateFundBalance(200_000n, [{ amount: 100_000n, status }])).toEqual({
        currentBalance: 200_000n,
        reservedRefund: 0n,
        availableBalance: 200_000n,
      });
    },
  );

  it('keeps available balance stable when refund confirmation records OUT and releases the reservation', () => {
    const before = calculateFundBalance(300_000n, [
      { amount: 100_000n, status: 'HOLDER_REPORTED' },
    ]);
    const after = calculateFundBalance(200_000n, [{ amount: 100_000n, status: 'CONFIRMED' }]);

    expect(before.availableBalance).toBe(200_000n);
    expect(after.availableBalance).toBe(before.availableBalance);
  });

  it('rejects spending money reserved for a refund even when current balance is sufficient', () => {
    const refunds: RefundForBalance[] = [{ amount: 100_000n, status: 'PENDING' }];

    expect(() => assertCanSpend(300_000n, refunds, 200_000n)).not.toThrow();
    expect(() => assertCanSpend(300_000n, refunds, 200_001n)).toThrow(
      InsufficientAvailableBalanceError,
    );
  });

  it('rejects any positive spend when all funds are reserved', () => {
    const refunds: RefundForBalance[] = [{ amount: 300_000n, status: 'HOLDER_REPORTED' }];
    expect(calculateFundBalance(300_000n, refunds).availableBalance).toBe(0n);
    expect(() => assertCanSpend(300_000n, refunds, 1n)).toThrow(InsufficientAvailableBalanceError);
  });

  it('does not hide inconsistent data by clamping an over-reservation to zero', () => {
    expect(() =>
      calculateFundBalance(300_000n, [
        { amount: 200_000n, status: 'PENDING' },
        { amount: 100_001n, status: 'HOLDER_REPORTED' },
      ]),
    ).toThrow(RangeError);
  });

  it('preserves one-dong differences above the JavaScript number precision limit', () => {
    const currentBalance = 9_007_199_254_740_995n;
    const refunds: RefundForBalance[] = [{ amount: 9_007_199_254_740_993n, status: 'PENDING' }];
    expect(calculateFundBalance(currentBalance, refunds).availableBalance).toBe(2n);
    expect(() => assertCanSpend(currentBalance, refunds, 2n)).not.toThrow();
    expect(() => assertCanSpend(currentBalance, refunds, 3n)).toThrow(
      InsufficientAvailableBalanceError,
    );
  });

  it.each([-1n, 9_223_372_036_854_775_808n])('rejects an invalid current balance %s', (amount) => {
    expect(() => calculateFundBalance(amount, [])).toThrow(RangeError);
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n])(
    'rejects invalid spend and refund amounts %s',
    (amount) => {
      expect(() => assertCanSpend(300_000n, [], amount)).toThrow(RangeError);
      expect(() => calculateFundBalance(300_000n, [{ amount, status: 'PENDING' }])).toThrow(
        RangeError,
      );
    },
  );

  it('does not mutate the input refunds', () => {
    const refunds = Object.freeze([
      Object.freeze({ amount: 100_000n, status: 'PENDING' as const }),
    ]);
    const expected = [{ amount: 100_000n, status: 'PENDING' }];

    calculateFundBalance(300_000n, refunds);
    assertCanSpend(300_000n, refunds, 200_000n);
    expect(refunds).toEqual(expected);
  });
});
