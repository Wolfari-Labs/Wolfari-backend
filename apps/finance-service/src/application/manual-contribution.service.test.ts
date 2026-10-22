import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import type { FundQueryService } from './fund-query.service';
import type { FundCommandService } from './fund-command.service';
import type { ReceiptService } from '../receipts/receipt.service';
import { ManualContributionService } from './manual-contribution.service';
const id = '10000000-0000-4000-8000-000000000001',
  holder = '20000000-0000-4000-8000-000000000001';
function setup() {
  const db = {
    query: vi
      .fn()
      .mockResolvedValue({
        rows: [
          {
            fund_id: id,
            request_id: id,
            trip_id: id,
            member_user_id: id,
            transfer_evidence_object_key: 'current',
          },
        ],
      }),
  };
  const queries = { getFund: vi.fn().mockResolvedValue({ fund: { holder_user_id: holder } }) };
  const commands = { run: vi.fn().mockResolvedValue({ contribution: {} }) };
  const files = { prepareAttachment: vi.fn().mockResolvedValue({}) };
  const service = new ManualContributionService(
    db as unknown as DatabaseProvider,
    queries as unknown as FundQueryService,
    commands as unknown as FundCommandService,
    files as unknown as ReceiptService,
  );
  return { db, queries, commands, files, service };
}
const request = {
  operation_id: id,
  actor_user_id: id,
  contribution_id: id,
  expected_version: 1,
  expected_finance_version: 2,
};
describe('Manual contribution application', () => {
  it.each(['CONFIRM_RECEIVED', 'REJECT_TRANSFER'] as const)(
    'requires current Holder for %s, before the guard',
    async (scope) => {
      const s = setup();
      await expect(
        s.service.run(
          scope,
          { ...request, reason: scope === 'REJECT_TRANSFER' ? 'not received' : undefined },
          id,
          Date.now() + 2000,
        ),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(s.commands.run).not.toHaveBeenCalled();
    },
  );
  it('requires Self for reports; membership revocation blocks even replay', async () => {
    const s = setup();
    await expect(
      s.service.run(
        'REPORT_TRANSFER',
        { ...request, actor_user_id: holder },
        id,
        Date.now() + 2000,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    s.queries.getFund.mockRejectedValue({ code: 'RESOURCE_NOT_FOUND' });
    await expect(
      s.service.run('REPORT_TRANSFER', request, id, Date.now() + 2000),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(s.commands.run).not.toHaveBeenCalled();
  });
  it('defers storage verification to new commands and allows reuse only of current evidence', async () => {
    const s = setup();
    await s.service.run(
      'REPORT_TRANSFER',
      { ...request, evidence_object_key: 'current' },
      id,
      Date.now() + 2000,
    );
    expect(s.files.prepareAttachment).not.toHaveBeenCalled();
    await s.commands.run.mock.calls[0]![3]!();
    expect(s.files.prepareAttachment).toHaveBeenCalledWith(
      id,
      'current',
      id,
      expect.any(AbortSignal),
      id,
    );
  });
  it.each([{ reason: ' ' }, { expected_version: 0 }, { evidence_object_key: null }])(
    'rejects malformed input before resolving scope',
    async (patch) => {
      const s = setup();
      await expect(
        s.service.run('REPORT_TRANSFER', { ...request, ...patch } as never, id, Date.now() + 2000),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(s.db.query).not.toHaveBeenCalled();
    },
  );
});
