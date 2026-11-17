import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@wolfari/database';
import { ExpenseService } from './expense.service';
import { FinancialNoteService } from './financial-note.service';
import type { FundCommandService } from './fund-command.service';

const id = '10000000-0000-4000-8000-000000000001';
const fund = '20000000-0000-4000-8000-000000000002';
const trip = '30000000-0000-4000-8000-000000000003';
const request = {
  operation_id: id,
  actor_user_id: id,
  expense_id: id,
  note_id: id,
  expected_version: 2,
  expected_finance_version: 3,
};

function setup(deleted: boolean, stored: boolean) {
  const db = {
    query: vi.fn(async (sql: string) =>
      sql.includes('FROM funds')
        ? { rows: [{ trip_id: trip }] }
        : { rows: [{ fund_id: fund, deleted }] },
    ),
  };
  const commands = {
    hasReceipt: vi.fn().mockResolvedValue(stored),
    run: vi.fn().mockResolvedValue({ operation: { operation_id: id, state: 3 } }),
  };
  const expenses = new ExpenseService(
    db as unknown as DatabaseProvider,
    {} as never,
    {} as never,
    commands as unknown as FundCommandService,
    {} as never,
  );
  const notes = new FinancialNoteService(
    db as unknown as DatabaseProvider,
    {} as never,
    {} as never,
    commands as unknown as FundCommandService,
  );
  return {
    commands,
    run: [
      () => expenses.manage('DELETE_EXPENSE', request, id, Date.now() + 2000),
      () => notes.manage('DELETE_FINANCIAL_NOTE', request, id, Date.now() + 2000),
    ],
  };
}

describe('DELETE replay after the row is soft-deleted', () => {
  it.each([0, 1])('returns the stored receipt for the same operation (%i)', async (index) => {
    const s = setup(true, true);
    await expect(s.run[index]!()).resolves.toEqual({ operation: { operation_id: id, state: 3 } });
    expect(s.commands.hasReceipt).toHaveBeenCalledWith(id);
    expect(s.commands.run.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ operationId: id, fundId: fund, tripId: trip }),
    );
  });
  it.each([0, 1])('keeps a new operation on a deleted row as 404 (%i)', async (index) => {
    const s = setup(true, false);
    await expect(s.run[index]!()).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(s.commands.run).not.toHaveBeenCalled();
  });
  it.each([0, 1])('does not consult receipts for a live row (%i)', async (index) => {
    const s = setup(false, false);
    await s.run[index]!();
    expect(s.commands.hasReceipt).not.toHaveBeenCalled();
    expect(s.commands.run).toHaveBeenCalled();
  });
});
