import { describe, expect, it } from 'vitest';
import { expenseRoute, projectExpense } from './expense-http';

const id = '10000000-0000-4000-8000-000000000001';
const at = { seconds: '1792630923', nanos: 4000000 };

describe('expense HTTP projection', () => {
  it('matches only published collection and item actions', () => {
    expect(expenseRoute(`/api/v1/funds/${id}/expenses`)).toEqual({
      kind: 'collection',
      fundId: id,
    });
    expect(expenseRoute(`/api/v1/expenses/${id}/submit`)).toEqual({
      kind: 'item',
      expenseId: id,
      action: 'submit',
    });
    expect(expenseRoute(`/api/v1/expenses/${id}/confirm`)).toBeUndefined();
  });

  it('projects a strict public expense without private receipt key', () => {
    const result = projectExpense({
      id,
      fund_id: id,
      title: 'Taxi',
      amount: '9007199254740993',
      status: 'DRAFT',
      created_by_user_id: id,
      receipt_available: true,
      created_at: at,
      updated_at: at,
      version: 1,
      finance_version: 2,
      receipt_object_key: 'must-not-leak',
    });
    expect(result.amount).toBe('9007199254740993');
    expect(result.receipt_available).toBe(true);
    expect(result).not.toHaveProperty('receipt_object_key');
  });
});
