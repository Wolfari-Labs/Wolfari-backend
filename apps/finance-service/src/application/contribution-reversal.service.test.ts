import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import type { FundQueryService } from './fund-query.service';
import type { FundCommandService } from './fund-command.service';
import { ContributionReversalService } from './contribution-reversal.service';

const id = '10000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000001';
const request = {
  operation_id: id,
  actor_user_id: id,
  contribution_id: id,
  reason: ' Recorded twice ',
  expected_version: 2,
  expected_finance_version: 5,
};

function setup(holder = id) {
  const db = {
    query: vi.fn().mockResolvedValue({ rows: [{ fund_id: id, request_id: id, trip_id: id }] }),
  };
  const queries = { getFund: vi.fn().mockResolvedValue({ fund: { holder_user_id: holder } }) };
  const commands = { run: vi.fn().mockResolvedValue({ contribution: { id } }) };
  const service = new ContributionReversalService(
    db as unknown as DatabaseProvider,
    queries as unknown as FundQueryService,
    commands as unknown as FundCommandService,
  );
  return { db, queries, commands, service };
}

describe('Contribution reversal application', () => {
  it('resolves stored scope, requires the current Holder and delegates a normalized command', async () => {
    const s = setup();
    await s.service.run(request, id, Date.now() + 2000);
    expect(s.commands.run).toHaveBeenCalledWith(
      {
        scope: 'REVERSE_CONTRIBUTION',
        operationId: id,
        actor: id,
        tripId: id,
        fundId: id,
        requestId: id,
        contributionId: id,
        body: { reason: 'Recorded twice', expectedVersion: 2, expectedFinanceVersion: 5 },
      },
      id,
      expect.any(Number),
    );
  });

  it('blocks a former Holder before opening the durable operation', async () => {
    const s = setup(other);
    await expect(s.service.run(request, id, Date.now() + 2000)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(s.commands.run).not.toHaveBeenCalled();
  });

  it.each([{ reason: ' ' }, { reason: 'x'.repeat(1025) }, { expected_version: 0 }])(
    'rejects malformed input before reading scope %#',
    async (patch) => {
      const s = setup();
      await expect(
        s.service.run({ ...request, ...patch } as never, id, Date.now() + 2000),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(s.db.query).not.toHaveBeenCalled();
    },
  );
});
