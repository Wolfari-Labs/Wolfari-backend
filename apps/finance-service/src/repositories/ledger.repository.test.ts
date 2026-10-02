import { describe, expect, it, vi } from 'vitest';
import { LedgerRepository } from './ledger.repository';

const fundId = '40000000-0000-4000-8000-000000000001';
const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const row = (sequence = '9007199254740993') => ({
  id: '50000000-0000-4000-8000-000000000001',
  fund_id: fundId,
  sequence,
  direction: 'IN',
  transaction_type: 'REVERSAL',
  amount: '9007199254740993',
  balance_after: '9223372036854775807',
  contribution_id: null,
  expense_id: null,
  refund_id: null,
  reversal_of_id: '50000000-0000-4000-8000-000000000002',
  actor_user_id: null,
  reason: 'Correction',
  created_at: new Date('2026-09-30T00:00:00Z'),
});
const withRows = (rows: unknown[]) => {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, repository: new LedgerRepository({ query }) };
};

describe('LedgerRepository', () => {
  it.each(['IN ', 'OUT'])('normalizes PostgreSQL char(3) direction %s', async (direction) => {
    const { repository } = withRows([{ ...row(), direction }]);
    expect((await repository.listByFundId(fundId)).items[0]?.direction).toBe(direction.trimEnd());
  });

  it('rejects an unknown stored direction', async () => {
    const { repository } = withRows([{ ...row(), direction: 'BAD' }]);
    await expect(repository.listByFundId(fundId)).rejects.toThrow(TypeError);
  });

  it('returns an empty page with the default bounded query', async () => {
    const { repository, query } = withRows([]);
    expect(await repository.listByFundId(fundId)).toEqual({ items: [], nextCursor: null });
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('ORDER BY sequence DESC'),
      [fundId, null, 21],
    );
  });

  it('maps money, sequence and nullable source metadata without losing precision', async () => {
    const { repository } = withRows([row()]);
    expect(await repository.listByFundId(fundId)).toEqual({
      items: [
        {
          id: row().id,
          fundId,
          sequence: 9007199254740993n,
          direction: 'IN',
          transactionType: 'REVERSAL',
          amount: 9007199254740993n,
          balanceAfter: 9223372036854775807n,
          contributionId: null,
          expenseId: null,
          refundId: null,
          reversalOfId: row().reversal_of_id,
          actorUserId: null,
          reason: 'Correction',
          createdAt: row().created_at,
        },
      ],
      nextCursor: null,
    });
  });

  it('uses the last visible sequence, not the lookahead row, for continuation', async () => {
    const { repository, query } = withRows([row('9'), row('5'), row('1')]);
    const first = await repository.listByFundId(fundId, { limit: 2 });
    expect(first.items.map((item) => item.sequence)).toEqual([9n, 5n]);
    expect(first.nextCursor).toBe(cursor([1, fundId, '5']));
    query.mockResolvedValueOnce({ rows: [row('1')] });
    expect(
      await repository.listByFundId(fundId, { limit: 2, cursor: first.nextCursor! }),
    ).toMatchObject({ items: [{ sequence: 1n }], nextCursor: null });
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [fundId, '5', 3]);
  });

  it('returns no cursor when the final page exactly fills the limit', async () => {
    const { repository } = withRows([row('2'), row('1')]);
    expect((await repository.listByFundId(fundId, { limit: 2 })).nextCursor).toBeNull();
  });

  it('accepts the maximum limit and int8 sequence as SQL parameters', async () => {
    const { repository, query } = withRows([]);
    await repository.listByFundId(fundId, {
      limit: 100,
      cursor: cursor([1, fundId, '9223372036854775807']),
    });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [
      fundId,
      '9223372036854775807',
      101,
    ]);
  });

  it.each([0, -1, 101, 1.5, NaN, Infinity, '20', null])(
    'rejects limit %s before querying',
    async (limit) => {
      const { repository, query } = withRows([]);
      await expect(repository.listByFundId(fundId, { limit: limit as number })).rejects.toThrow(
        RangeError,
      );
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    '*invalid*',
    'x'.repeat(513),
    cursor(null),
    cursor([2, fundId, '1']),
    cursor([1, 'another-fund', '1']),
    cursor([1, fundId, 1]),
    cursor([1, fundId, '0']),
    cursor([1, fundId, '-1']),
    cursor([1, fundId, '1\n']),
    cursor([1, fundId, '01']),
    cursor([1, fundId, '9223372036854775808']),
    cursor([1, fundId, '1 OR true']),
    cursor([1, fundId, '1', 'extra']),
  ])('rejects malformed or differently scoped cursor %s', async (value) => {
    const { repository, query } = withRows([]);
    await expect(repository.listByFundId(fundId, { cursor: value })).rejects.toThrow(TypeError);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { field: 'sequence', value: '0' },
    { field: 'sequence', value: 9007199254740992 },
    { field: 'amount', value: '0' },
    { field: 'balance_after', value: '-1' },
  ])('rejects invalid stored $field', async ({ field, value }) => {
    const { repository } = withRows([{ ...row(), [field]: value }]);
    await expect(repository.listByFundId(fundId)).rejects.toThrow();
  });

  it('propagates database failures instead of returning an empty ledger', async () => {
    const failure = new Error('database unavailable');
    const repository = new LedgerRepository({ query: vi.fn().mockRejectedValue(failure) });
    await expect(repository.listByFundId(fundId)).rejects.toBe(failure);
  });
});
