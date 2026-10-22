import { describe, expect, it } from 'vitest';
import { FinanceReadError } from '../finance.errors';
import {
  expenseCursor,
  parseCreateExpense,
  parseExpenseAction,
  parseExpensePage,
  parseUpdateExpense,
} from './expense.input';

const fund = '10000000-0000-4000-8000-000000000001';
const expense = '10000000-0000-4000-8000-000000000002';
const invalid = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(FinanceReadError);
    expect((error as FinanceReadError).code).toBe('VALIDATION_FAILED');
    return;
  }
  throw new Error('Expected validation error');
};

describe('expense input', () => {
  it('parses exact VND and optional draft metadata', () => {
    expect(
      parseCreateExpense({
        title: '  Taxi sân bay  ',
        description: '  Cả nhóm  ',
        amount: '009007199254740993',
        category: 'Di chuyển',
        receipt_object_key: null,
        paid_at: '2026-10-22T10:15:30.123+07:00',
        payment_method: 'CASH',
        expected_finance_version: 4,
      }),
    ).toMatchObject({
      title: 'Taxi sân bay',
      description: 'Cả nhóm',
      amount: 9007199254740993n,
      receiptObjectKey: null,
      expectedFinanceVersion: 4,
    });
  });

  it('preserves PATCH presence and rejects empty or unknown patches', () => {
    expect(
      parseUpdateExpense({
        description: null,
        amount: '12',
        expected_version: 2,
        expected_finance_version: 5,
      }),
    ).toEqual({
      description: null,
      amount: 12n,
      expectedVersion: 2,
      expectedFinanceVersion: 5,
    });
    invalid(() => parseUpdateExpense({ expected_version: 1, expected_finance_version: 1 }));
    invalid(() =>
      parseUpdateExpense({
        amount: '1',
        actor_user_id: fund,
        expected_version: 1,
        expected_finance_version: 1,
      }),
    );
  });

  it('requires positive int32 versions and positive int64 money', () => {
    for (const value of ['0', '-1', '9223372036854775808'])
      invalid(() =>
        parseCreateExpense({
          title: 'Taxi',
          amount: value,
          expected_finance_version: 1,
        }),
      );
    invalid(() => parseExpenseAction({ expected_version: 0, expected_finance_version: 1 }));
  });

  it('binds an opaque cursor to Fund and status while retaining microseconds', () => {
    const cursor = expenseCursor(
      { fundId: fund, status: 'DRAFT' },
      { at: '2026-10-22T03:15:30.123456Z', id: expense },
    );
    expect(parseExpensePage({ fund_id: fund, status: 'DRAFT', cursor })).toEqual({
      fundId: fund,
      status: 'DRAFT',
      limit: 20,
      after: { at: '2026-10-22T03:15:30.123456Z', id: expense },
    });
    invalid(() => parseExpensePage({ fund_id: fund, status: 'SUBMITTED', cursor }));
  });
});
