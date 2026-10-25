import { describe, expect, it } from 'vitest';
import { expenseResponse, type ExpenseRow } from './expense-response';

const row: ExpenseRow = {
  id: '10000000-0000-4000-8000-000000000001',
  fund_id: '10000000-0000-4000-8000-000000000002',
  title: 'Taxi',
  description: null,
  amount: '9007199254740993',
  category: null,
  receipt_object_key: 'private/key.pdf',
  status: 'DRAFT',
  created_by_user_id: '10000000-0000-4000-8000-000000000003',
  submitted_at: null,
  paid_at: null,
  payment_method: null,
  paid_by_user_id: null,
  confirmed_at: null,
  confirmed_by_user_id: null,
  rejected_reason: null,
  created_at: '2026-10-22T01:02:03.004Z',
  updated_at: '2026-10-22T01:02:03.005Z',
  version: 1,
};

describe('expense response', () => {
  it('keeps exact money and exposes availability without leaking the object key', () => {
    const result = expenseResponse(row, 7);
    expect(result).toMatchObject({
      amount: '9007199254740993',
      receipt_available: true,
      finance_version: 7,
    });
    expect(JSON.stringify(result)).not.toContain('private/key.pdf');
    expect(result.description).toBeUndefined();
  });
});
