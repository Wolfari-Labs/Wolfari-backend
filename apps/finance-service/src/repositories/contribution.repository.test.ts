import { describe, expect, it, vi } from 'vitest';
import { ContributionRepository } from './contribution.repository';

const scope = {
  fundId: '40000000-0000-4000-8000-000000000001',
  requestId: '50000000-0000-4000-8000-000000000001',
  contributionId: '60000000-0000-4000-8000-000000000001',
};
const date = new Date('2026-09-30T00:00:00Z');
const requestRow = () => ({
  id: scope.requestId,
  fund_id: scope.fundId,
  title: 'Trip budget',
  amount_per_member: null,
  due_at: null,
  note: null,
  status: 'OPEN',
  version: 2,
  created_by_user_id: 'holder',
  created_at: date,
  closed_at: null,
});
const contributionRow = () => ({
  id: scope.contributionId,
  fund_id: scope.fundId,
  request_id: scope.requestId,
  member_user_id: 'member',
  amount: '9007199254740993',
  status: 'TRANSFER_REPORTED',
  version: 3,
  self_contribution: false,
  member_reported_at: date,
  confirmed_by_user_id: null,
  confirmed_at: null,
  waived_reason: null,
  cancelled_reason: null,
  rejected_reason: 'Previous report not received',
  waived_at: null,
  cancelled_at: null,
  reversed_at: null,
  created_at: date,
  updated_at: date,
});
function withRows(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, repository: new ContributionRepository({ query }) };
}

describe('ContributionRepository', () => {
  it('returns null for absent or differently scoped records', async () => {
    const { repository } = withRows([]);
    expect(await repository.findRequestById(scope)).toBeNull();
    expect(await repository.findById(scope)).toBeNull();
  });

  it('keeps request optional fields null', async () => {
    const { repository } = withRows([requestRow()]);
    expect(await repository.findRequestById(scope)).toEqual({
      id: scope.requestId,
      fundId: scope.fundId,
      title: 'Trip budget',
      amountPerMember: null,
      dueAt: null,
      note: null,
      status: 'OPEN',
      version: 2,
      createdByUserId: 'holder',
      createdAt: date,
      closedAt: null,
    });
  });

  it('maps a closed request with exact int8 amount, deadline and note', async () => {
    const { repository } = withRows([
      {
        ...requestRow(),
        amount_per_member: '9223372036854775807',
        due_at: date,
        note: 'Final round',
        closed_at: date,
        status: 'CLOSED',
      },
    ]);
    expect(await repository.findRequestById(scope)).toMatchObject({
      amountPerMember: 9223372036854775807n,
      dueAt: date,
      note: 'Final round',
      closedAt: date,
      status: 'CLOSED',
    });
  });

  it('maps contribution history without copying private destination/evidence fields', async () => {
    const { repository } = withRows([
      {
        ...contributionRow(),
        destination_snapshot: { account_number: 'test-private' },
        transfer_evidence_object_key: 'private/evidence',
      },
    ]);
    expect(await repository.findById(scope)).toEqual({
      id: scope.contributionId,
      requestId: scope.requestId,
      fundId: scope.fundId,
      memberUserId: 'member',
      amount: 9007199254740993n,
      status: 'TRANSFER_REPORTED',
      version: 3,
      selfContribution: false,
      memberReportedAt: date,
      confirmedByUserId: null,
      confirmedAt: null,
      waivedReason: null,
      cancelledReason: null,
      rejectedReason: 'Previous report not received',
      waivedAt: null,
      cancelledAt: null,
      reversedAt: null,
      createdAt: date,
      updatedAt: date,
    });
  });

  it('binds every scope ID as a parameter and excludes private columns from SQL', async () => {
    const { repository, query } = withRows([]);
    await repository.findRequestById(scope);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('fund_id = $1 AND id = $2'), [
      scope.fundId,
      scope.requestId,
    ]);
    await repository.findById(scope);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('fund_id = $1 AND request_id = $2 AND id = $3'),
      [scope.fundId, scope.requestId, scope.contributionId],
    );
    expect(query.mock.calls[1]![0]).not.toMatch(
      /destination_snapshot|transfer_evidence_object_key/,
    );
  });

  it.each(['0', '-1', '9223372036854775808', 100])(
    'rejects invalid stored money %s in both readers',
    async (amount) => {
      const { repository, query } = withRows([{ ...requestRow(), amount_per_member: amount }]);
      await expect(repository.findRequestById(scope)).rejects.toThrow();
      query.mockResolvedValueOnce({ rows: [{ ...contributionRow(), amount }] });
      await expect(repository.findById(scope)).rejects.toThrow();
    },
  );

  it('propagates DB failures instead of returning null', async () => {
    const failure = new Error('database unavailable');
    const repository = new ContributionRepository({ query: vi.fn().mockRejectedValue(failure) });
    await expect(repository.findRequestById(scope)).rejects.toBe(failure);
    await expect(repository.findById(scope)).rejects.toBe(failure);
  });
});
