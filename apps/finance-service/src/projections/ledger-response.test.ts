import { describe, it, expect } from 'vitest';
import { ledgerResponse } from './ledger-response';
import type { LedgerRecord } from '../repositories/ledger.repository';
const id = '10000000-0000-4000-8000-000000000001';
const row: LedgerRecord = {
  id,
  fundId: id,
  sequence: 9007199254740993n,
  direction: 'IN',
  transactionType: 'REVERSAL',
  amount: 9007199254740993n,
  balanceAfter: 9223372036854775807n,
  contributionId: null,
  expenseId: null,
  refundId: null,
  reversalOfId: id,
  actorUserId: null,
  reason: 'Correction',
  createdAt: new Date('2026-10-15T00:00:00Z'),
};
describe('Ledger API projection', () => {
  it('preserves int64 and nullable source fields without exposing storage keys', () => {
    const stored = { ...row, business_key: 'PRIVATE', destination_snapshot: { secret: 'PRIVATE' } };
    const result = ledgerResponse(stored, id);
    expect(result).toMatchObject({
      sequence: '9007199254740993',
      amount: '9007199254740993',
      balance_after: '9223372036854775807',
      actor_user_id: undefined,
      contribution_id: undefined,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it.each([
    { sequence: 0n },
    { amount: -1n },
    { balanceAfter: 9223372036854775808n },
    { transactionType: 'BAD' },
    { actorUserId: 'invalid' },
    { createdAt: new Date('invalid') },
  ])('fails closed for corrupt stored values', (patch) => {
    expect(() => ledgerResponse({ ...row, ...patch } as LedgerRecord, id)).toThrow();
  });
  it('rejects a row from another Fund', () => {
    expect(() => ledgerResponse(row, '20000000-0000-4000-8000-000000000001')).toThrow();
  });
});
