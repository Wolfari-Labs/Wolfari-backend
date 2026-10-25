import { describe, expect, it, vi } from 'vitest';
import { ExpenseRepository } from './expense.repository';
import type { FundWrite } from './fund-command.repository';

const fundId = '10000000-0000-4000-8000-000000000001';
const tripId = '10000000-0000-4000-8000-000000000002';
const actor = '10000000-0000-4000-8000-000000000003';
const expenseId = '10000000-0000-4000-8000-000000000004';
const file = 'funds/10000000-0000-4000-8000-000000000001/receipts/file.pdf';
const now = new Date('2026-10-22T01:02:03.004Z');
const row = {
  id: expenseId,
  fund_id: fundId,
  title: 'Taxi',
  description: null,
  amount: '100000',
  category: null,
  receipt_object_key: null,
  status: 'DRAFT',
  created_by_user_id: actor,
  submitted_at: null,
  paid_at: null,
  payment_method: null,
  paid_by_user_id: null,
  confirmed_at: null,
  confirmed_by_user_id: null,
  rejected_reason: null,
  created_at: now,
  updated_at: now,
  version: 1,
};
const authority = {
  actorUserId: actor,
  ownerUserId: actor,
  activeMemberUserIds: new Set([actor]),
  tripArchived: false,
};

describe('expense repository', () => {
  it('creates a DRAFT, binds its receipt and increments only Finance metadata', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('SELECT status,finance_version'))
          return { rows: [{ status: 'OPEN', finance_version: 8 }], rowCount: 1 };
        if (sql.includes('INSERT INTO fund_expenses'))
          return { rows: [{ ...row, receipt_object_key: file }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const bind = vi.fn().mockResolvedValue(undefined);
    const repo = new ExpenseRepository(client as never, { bind });
    const result = await repo.execute(
      client as never,
      {
        scope: 'CREATE_EXPENSE',
        operationId: expenseId,
        actor,
        tripId,
        fundId,
        hash: 'a'.repeat(64),
        body: {
          title: 'Taxi',
          description: null,
          amount: 100000n,
          category: null,
          receiptObjectKey: file,
          paidAt: null,
          paymentMethod: null,
          expectedFinanceVersion: 8,
        },
      } as FundWrite & { scope: 'CREATE_EXPENSE' },
      authority,
      expenseId,
    );
    expect(bind).toHaveBeenCalledWith(client, fundId, file, actor, { expenseId });
    expect(result.expense).toMatchObject({
      id: expenseId,
      status: 'DRAFT',
      finance_version: 9,
      receipt_available: true,
    });
    expect(statements.some((sql) => sql.includes('UPDATE funds SET finance_version'))).toBe(true);
    expect(statements.some((sql) => sql.includes('finance_audit_logs'))).toBe(true);
    expect(statements.some((sql) => sql.includes('fund_transactions'))).toBe(false);
  });

  it('stores a no-op PATCH result without incrementing versions or audit', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('SELECT status,finance_version'))
          return { rows: [{ status: 'OPEN', finance_version: 8 }], rowCount: 1 };
        if (sql.includes('SELECT id,fund_id,title')) return { rows: [row], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const repo = new ExpenseRepository(client as never);
    const result = await repo.execute(
      client as never,
      {
        scope: 'UPDATE_EXPENSE',
        operationId: expenseId,
        actor,
        tripId,
        fundId,
        expenseId,
        hash: 'a'.repeat(64),
        body: {
          title: 'Taxi',
          expectedVersion: 1,
          expectedFinanceVersion: 8,
        },
      } as FundWrite & { scope: 'UPDATE_EXPENSE' },
      authority,
      expenseId,
    );
    expect(result.expense).toMatchObject({ version: 1, finance_version: 8 });
    expect(statements.some((sql) => sql.startsWith('UPDATE'))).toBe(false);
    expect(statements.some((sql) => sql.includes('finance_audit_logs'))).toBe(false);
  });
});
