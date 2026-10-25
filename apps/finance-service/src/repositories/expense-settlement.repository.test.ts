import { describe, expect, it, vi } from 'vitest';
import { FinanceReadError } from '../finance.errors';
import { ExpenseRepository } from './expense.repository';
import type { FundWrite } from './fund-command.repository';

const fundId = '10000000-0000-4000-8000-000000000001';
const tripId = '10000000-0000-4000-8000-000000000002';
const holder = '10000000-0000-4000-8000-000000000003';
const expenseId = '10000000-0000-4000-8000-000000000004';
const ledgerId = '10000000-0000-4000-8000-000000000005';
const reversalId = '10000000-0000-4000-8000-000000000006';
const now = new Date('2026-10-22T01:02:03.004Z');
const submitted = {
  id: expenseId,
  fund_id: fundId,
  title: 'Taxi',
  description: null,
  amount: '100000',
  category: null,
  receipt_object_key: null,
  status: 'SUBMITTED',
  created_by_user_id: holder,
  submitted_at: now,
  paid_at: null,
  payment_method: null,
  paid_by_user_id: null,
  confirmed_at: null,
  confirmed_by_user_id: null,
  rejected_reason: null,
  created_at: now,
  updated_at: now,
  version: 2,
};
const authority = {
  actorUserId: holder,
  ownerUserId: holder,
  activeMemberUserIds: new Set([holder]),
  tripArchived: false,
};
const command = {
  operationId: reversalId,
  actor: holder,
  tripId,
  fundId,
  expenseId,
  hash: 'a'.repeat(64),
};

describe('expense settlement repository', () => {
  it('confirms with one OUT entry after subtracting active refund reservations', async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT status,finance_version'))
          return {
            rows: [
              {
                status: 'OPEN',
                finance_version: 8,
                holder_user_id: holder,
                current_balance: '300000',
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('SELECT id,fund_id,title')) return { rows: [submitted], rowCount: 1 };
        if (sql.startsWith('SELECT amount::text,status FROM fund_refunds'))
          return { rows: [{ amount: '50000', status: 'PENDING' }], rowCount: 1 };
        if (sql.startsWith('SELECT COALESCE(MAX(sequence)'))
          return { rows: [{ sequence: '4' }], rowCount: 1 };
        if (sql.includes('INSERT INTO fund_transactions'))
          return { rows: [{ id: ledgerId }], rowCount: 1 };
        if (sql.includes("UPDATE fund_expenses SET status='CONFIRMED'"))
          return {
            rows: [
              {
                ...submitted,
                status: 'CONFIRMED',
                paid_at: now,
                payment_method: 'BANK_TRANSFER',
                paid_by_user_id: holder,
                confirmed_at: now,
                confirmed_by_user_id: holder,
                version: 3,
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 1 };
      }),
    };
    const repo = new ExpenseRepository(client as never);
    const result = await repo.execute(
      client as never,
      {
        ...command,
        scope: 'CONFIRM_EXPENSE',
        body: {
          paidAt: now,
          paymentMethod: 'BANK_TRANSFER',
          expectedVersion: 2,
          expectedFinanceVersion: 8,
        },
      } as FundWrite & { scope: 'CONFIRM_EXPENSE' },
      authority,
      reversalId,
    );

    expect(result.expense).toMatchObject({ status: 'CONFIRMED', finance_version: 9, version: 3 });
    const ledger = calls.find((call) => call.sql.includes('INSERT INTO fund_transactions'))!;
    expect(ledger.sql).toContain("VALUES($1,$2,'OUT','EXPENSE'");
    expect(ledger.values).toEqual([
      fundId,
      '5',
      '100000',
      '200000',
      expenseId,
      holder,
      `expense:${expenseId}`,
    ]);
    expect(
      calls.find((call) => call.sql.includes('UPDATE funds SET current_balance'))?.values,
    ).toEqual([fundId, '200000', 9]);
  });

  it('rejects an expense without creating a ledger entry', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('SELECT status,finance_version'))
          return {
            rows: [
              {
                status: 'OPEN',
                finance_version: 8,
                holder_user_id: holder,
                current_balance: '300000',
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('SELECT id,fund_id,title')) return { rows: [submitted], rowCount: 1 };
        if (sql.includes("UPDATE fund_expenses SET status='REJECTED'"))
          return {
            rows: [{ ...submitted, status: 'REJECTED', rejected_reason: 'Duplicate', version: 3 }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 1 };
      }),
    };
    const repo = new ExpenseRepository(client as never);
    const result = await repo.execute(
      client as never,
      {
        ...command,
        scope: 'REJECT_EXPENSE',
        body: { reason: 'Duplicate', expectedVersion: 2, expectedFinanceVersion: 8 },
      } as FundWrite & { scope: 'REJECT_EXPENSE' },
      authority,
      reversalId,
    );
    expect(result.expense).toMatchObject({ status: 'REJECTED', rejected_reason: 'Duplicate' });
    expect(statements.some((sql) => sql.includes('INSERT INTO fund_transactions'))).toBe(false);
    expect(statements.some((sql) => sql.includes('SET current_balance'))).toBe(false);
  });

  it('blocks confirmation when refund reservations leave insufficient available balance', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('SELECT status,finance_version'))
          return {
            rows: [
              {
                status: 'OPEN',
                finance_version: 8,
                holder_user_id: holder,
                current_balance: '120000',
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('SELECT id,fund_id,title')) return { rows: [submitted], rowCount: 1 };
        if (sql.startsWith('SELECT amount::text,status FROM fund_refunds'))
          return { rows: [{ amount: '30000', status: 'HOLDER_REPORTED' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const repo = new ExpenseRepository(client as never);
    await expect(
      repo.execute(
        client as never,
        {
          ...command,
          scope: 'CONFIRM_EXPENSE',
          body: {
            paidAt: now,
            paymentMethod: 'CASH',
            expectedVersion: 2,
            expectedFinanceVersion: 8,
          },
        } as FundWrite & { scope: 'CONFIRM_EXPENSE' },
        authority,
        reversalId,
      ),
    ).rejects.toMatchObject<Partial<FinanceReadError>>({ code: 'STATE_CONFLICT' });
    expect(statements.some((sql) => sql.includes('INSERT INTO fund_transactions'))).toBe(false);
  });

  it('reverses the exact expense OUT with one linked IN entry', async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const confirmed = {
      ...submitted,
      status: 'CONFIRMED',
      paid_at: now,
      payment_method: 'CASH',
      paid_by_user_id: holder,
      confirmed_at: now,
      confirmed_by_user_id: holder,
      version: 3,
    };
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT status,finance_version'))
          return {
            rows: [
              {
                status: 'OPEN',
                finance_version: 9,
                holder_user_id: holder,
                current_balance: '200000',
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('SELECT id,fund_id,title')) return { rows: [confirmed], rowCount: 1 };
        if (sql.includes('WHERE fund_id=$1 AND expense_id=$2'))
          return {
            rows: [
              {
                id: ledgerId,
                direction: 'OUT',
                transaction_type: 'EXPENSE',
                amount: '100000',
                reversal_of_id: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.startsWith('SELECT id FROM fund_transactions WHERE reversal_of_id'))
          return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT amount::text,status FROM fund_refunds'))
          return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT COALESCE(MAX(sequence)'))
          return { rows: [{ sequence: '5' }], rowCount: 1 };
        if (sql.includes('INSERT INTO fund_transactions'))
          return { rows: [{ id: reversalId }], rowCount: 1 };
        if (sql.includes("UPDATE fund_expenses SET status='REVERSED'"))
          return { rows: [{ ...confirmed, status: 'REVERSED', version: 4 }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const repo = new ExpenseRepository(client as never);
    const result = await repo.execute(
      client as never,
      {
        ...command,
        scope: 'REVERSE_EXPENSE',
        body: { reason: 'Payment returned', expectedVersion: 3, expectedFinanceVersion: 9 },
      } as FundWrite & { scope: 'REVERSE_EXPENSE' },
      authority,
      reversalId,
    );

    expect(result.expense).toMatchObject({ status: 'REVERSED', finance_version: 10, version: 4 });
    const ledger = calls.find((call) => call.sql.includes('INSERT INTO fund_transactions'))!;
    expect(ledger.sql).toContain("VALUES($1,$2,'IN','REVERSAL'");
    expect(ledger.values).toEqual([
      fundId,
      '6',
      '100000',
      '300000',
      ledgerId,
      holder,
      'Payment returned',
      `reversal:expense:${expenseId}`,
    ]);
  });
});
