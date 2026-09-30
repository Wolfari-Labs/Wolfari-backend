import { describe, expect, it, vi } from 'vitest';
import { FundRepository } from './fund.repository';

const tripId = '20000000-0000-4000-8000-000000000001';
const row = () => ({
  id: '40000000-0000-4000-8000-000000000001',
  trip_id: tripId,
  holder_user_id: '10000000-0000-4000-8000-000000000001',
  currency: 'VND',
  budget_amount: '9223372036854775807',
  current_balance: '9007199254740993',
  status: 'OPEN',
  finance_version: 3,
  created_at: new Date('2026-09-17T01:00:00.000Z'),
  updated_at: new Date('2026-09-30T01:00:00.000Z'),
  closed_at: null,
});

function repositoryWithRows(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { repository: new FundRepository({ query }), query };
}

describe('FundRepository', () => {
  it('returns null when the Trip has no Fund', async () => {
    const { repository } = repositoryWithRows([]);
    expect(await repository.findByTripId(tripId)).toBeNull();
  });

  it('maps a stored Fund and preserves money above the safe Number range', async () => {
    const { repository } = repositoryWithRows([row()]);
    expect(await repository.findByTripId(tripId)).toEqual({
      id: row().id,
      tripId,
      holderUserId: row().holder_user_id,
      currency: 'VND',
      budgetAmount: 9223372036854775807n,
      currentBalance: 9007199254740993n,
      status: 'OPEN',
      financeVersion: 3,
      createdAt: row().created_at,
      updatedAt: row().updated_at,
      closedAt: null,
    });
  });

  it.each([
    { stored: null, expected: null },
    { stored: '0', expected: 0n },
  ])('keeps budget $stored distinct from an absent Fund', async ({ stored, expected }) => {
    const { repository } = repositoryWithRows([
      { ...row(), budget_amount: stored, current_balance: '0' },
    ]);
    expect(await repository.findByTripId(tripId)).toMatchObject({
      budgetAmount: expected,
      currentBalance: 0n,
    });
  });

  it('reads a closed Fund without filtering away its history', async () => {
    const closedAt = new Date('2026-09-30T02:00:00.000Z');
    const { repository } = repositoryWithRows([
      { ...row(), status: 'CLOSED', closed_at: closedAt },
    ]);
    expect(await repository.findByTripId(tripId)).toMatchObject({
      status: 'CLOSED',
      closedAt,
    });
  });

  it('passes the lookup value as a SQL parameter, never interpolated SQL', async () => {
    const input = "' OR true --";
    const { repository, query } = repositoryWithRows([]);
    await repository.findByTripId(input);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('trip_id = $1'), [input]);
    expect(query.mock.calls[0]![0]).not.toContain(input);
  });

  it('propagates a query failure instead of reporting a missing Fund', async () => {
    const failure = new Error('connection unavailable');
    const query = vi.fn().mockRejectedValue(failure);
    const repository = new FundRepository({ query });
    await expect(repository.findByTripId(tripId)).rejects.toBe(failure);
  });

  it.each([
    { field: 'current_balance', value: 9007199254740992, error: TypeError },
    { field: 'budget_amount', value: 100, error: TypeError },
    { field: 'current_balance', value: '-1', error: TypeError },
    { field: 'budget_amount', value: '9223372036854775808', error: RangeError },
  ])('rejects unexpected stored money: $field = $value', async ({ field, value, error }) => {
    const { repository } = repositoryWithRows([{ ...row(), [field]: value }]);
    await expect(repository.findByTripId(tripId)).rejects.toThrow(error);
  });
});
