import { describe, expect, it } from 'vitest';
import { InsufficientAvailableBalanceError } from './fund-balance';
import {
  calculateLedgerReversal,
  LedgerReversalNotAllowedError,
  type LedgerEntryForReversal,
  type LedgerReversalContext,
} from './ledger-reversal';

const original: LedgerEntryForReversal = {
  id: 'contribution-ledger-entry',
  direction: 'IN',
  amount: 200_000n,
  reversalOfId: null,
};

const context: LedgerReversalContext = {
  currentBalance: 300_000n,
  refunds: [{ amount: 100_000n, status: 'PENDING' }],
  hasExistingReversal: false,
};

describe('ledger reversal rules', () => {
  it('offsets an IN entry with the exact amount while preserving reserved money', () => {
    expect(calculateLedgerReversal(original, context)).toEqual({
      reversalOfId: original.id,
      direction: 'OUT',
      amount: 200_000n,
      balanceAfter: 100_000n,
    });
  });

  it('offsets an OUT entry with an IN even when all current funds are reserved', () => {
    expect(
      calculateLedgerReversal(
        { ...original, id: 'expense-ledger-entry', direction: 'OUT' },
        { ...context, currentBalance: 100_000n },
      ),
    ).toEqual({
      reversalOfId: 'expense-ledger-entry',
      direction: 'IN',
      amount: 200_000n,
      balanceAfter: 300_000n,
    });
  });

  it('rejects an IN reversal that would spend a holder-reported refund reservation', () => {
    expect(() =>
      calculateLedgerReversal(original, {
        ...context,
        refunds: [{ amount: 100_001n, status: 'HOLDER_REPORTED' }],
      }),
    ).toThrow(InsufficientAvailableBalanceError);
  });

  it('rejects an IN reversal when the actual balance is insufficient', () => {
    expect(() =>
      calculateLedgerReversal(original, { ...context, currentBalance: 199_999n, refunds: [] }),
    ).toThrow(InsufficientAvailableBalanceError);
  });

  it('allows a reversal to spend the whole balance when nothing is reserved', () => {
    expect(
      calculateLedgerReversal(original, { ...context, currentBalance: 200_000n, refunds: [] })
        .balanceAfter,
    ).toBe(0n);
  });

  it('rejects reversing a reversal entry', () => {
    expect(() =>
      calculateLedgerReversal({ ...original, reversalOfId: 'earlier-ledger-entry' }, context),
    ).toThrow(LedgerReversalNotAllowedError);
  });

  it.each(['IN', 'OUT'] as const)('rejects an already reversed %s entry', (direction) => {
    expect(() =>
      calculateLedgerReversal(
        { ...original, direction },
        { ...context, hasExistingReversal: true },
      ),
    ).toThrow(LedgerReversalNotAllowedError);
  });

  it('preserves the original amount exactly above the Number safe integer limit', () => {
    const effect = calculateLedgerReversal(
      { ...original, amount: 9_007_199_254_740_993n },
      { ...context, currentBalance: 9_007_199_254_740_995n, refunds: [] },
    );
    expect(effect.amount).toBe(9_007_199_254_740_993n);
    expect(effect.balanceAfter).toBe(2n);
  });

  it('rejects an OUT reversal that would overflow the balance', () => {
    expect(() =>
      calculateLedgerReversal(
        { ...original, direction: 'OUT', amount: 1n },
        { ...context, currentBalance: 9_223_372_036_854_775_807n },
      ),
    ).toThrow(RangeError);
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n])(
    'rejects invalid original amount %s in either direction',
    (amount) => {
      for (const direction of ['IN', 'OUT'] as const) {
        expect(() => calculateLedgerReversal({ ...original, amount, direction }, context)).toThrow(
          RangeError,
        );
      }
    },
  );

  it('does not hide an invalid reservation snapshot by adding money', () => {
    expect(() =>
      calculateLedgerReversal(
        { ...original, direction: 'OUT' },
        { ...context, currentBalance: 99_999n },
      ),
    ).toThrow(RangeError);
  });

  it('rejects an unknown direction instead of guessing the reverse direction', () => {
    expect(() =>
      calculateLedgerReversal(
        { ...original, direction: 'UNKNOWN' as LedgerEntryForReversal['direction'] },
        context,
      ),
    ).toThrow(TypeError);
  });

  it('keeps the original entry and reservation snapshot unchanged', () => {
    const frozenOriginal = Object.freeze({ ...original });
    const frozenContext = Object.freeze({
      ...context,
      refunds: Object.freeze([Object.freeze({ amount: 100_000n, status: 'PENDING' as const })]),
    });
    calculateLedgerReversal(frozenOriginal, frozenContext);
    expect(frozenOriginal).toEqual(original);
    expect(frozenContext).toEqual(context);
  });
});
