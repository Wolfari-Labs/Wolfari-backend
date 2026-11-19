import { describe, expect, it } from 'vitest';
import {
  blocksClosureWrite,
  closureBlockers,
  closureCounts,
  type ClosureCounts,
} from './closure-readiness';

const clear: ClosureCounts = {
  ledgerTotal: '0',
  contributions: 0,
  expenses: 0,
  refunds: 0,
  payments: 0,
  webhooks: 0,
  handovers: 0,
  bankTransfersNeedingReview: 0,
};

describe('closure readiness rules', () => {
  it('is ready only with a zero balance, zero ledger and nothing open', () => {
    expect(closureBlockers('0', clear)).toEqual([]);
    expect(blocksClosureWrite('0', clear)).toBe(false);
  });

  it('lists every open item per member individually, never as a bulk waiver', () => {
    expect(closureBlockers('200000', { ...clear, contributions: 3, expenses: 1 })).toEqual([
      { kind: 'CONTRIBUTIONS_OPEN', count: 3 },
      { kind: 'EXPENSES_OPEN', count: 1 },
      { kind: 'BALANCE_NOT_ZERO', count: 1 },
    ]);
  });

  it('treats a non-zero ledger as a balance blocker even when the cached balance is zero', () => {
    expect(closureBlockers('0', { ...clear, ledgerTotal: '1' })).toEqual([
      { kind: 'BALANCE_NOT_ZERO', count: 1 },
    ]);
  });

  it('keeps the handover on its own error path for writers', () => {
    expect(closureBlockers('0', { ...clear, handovers: 1 })).toEqual([
      { kind: 'HOLDER_HANDOVER_OPEN', count: 1 },
    ]);
    expect(blocksClosureWrite('0', { ...clear, handovers: 1 })).toBe(false);
    expect(blocksClosureWrite('0', { ...clear, payments: 1 })).toBe(true);
    expect(blocksClosureWrite('0', { ...clear, webhooks: 1 })).toBe(true);
    expect(blocksClosureWrite('0', { ...clear, refunds: 1 })).toBe(true);
  });

  it('blocks while bank transfers still need the Holder to resolve them', () => {
    expect(closureBlockers('0', { ...clear, bankTransfersNeedingReview: 2 })).toEqual([
      { kind: 'BANK_TRANSFERS_REVIEW', count: 2 },
    ]);
    expect(blocksClosureWrite('0', { ...clear, bankTransfersNeedingReview: 1 })).toBe(true);
  });

  it('reads all counts in one parameterised query', async () => {
    const calls: unknown[][] = [];
    const counts = await closureCounts(
      {
        query: async (...args: unknown[]) => {
          calls.push(args);
          return {
            rows: [
              {
                ledger_total: '0',
                contributions: 1,
                expenses: 0,
                refunds: 0,
                payments: 0,
                webhooks: 0,
                handovers: 0,
                bank_reviews: 4,
              },
            ],
          };
        },
      } as never,
      'fund-id',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual(['fund-id']);
    expect(counts).toMatchObject({ contributions: 1, bankTransfersNeedingReview: 4 });
  });
});
