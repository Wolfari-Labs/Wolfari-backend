import { describe, expect, it } from 'vitest';
import {
  assertCanCreateExpense,
  ExpenseRuleError,
  planExpenseMutation,
  planExpenseSettlement,
  type ExpenseState,
} from './expense-management';

const creator = '10000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000002';
const member = '10000000-0000-4000-8000-000000000003';
const holder = '10000000-0000-4000-8000-000000000005';
const context = (actorUserId: string) => ({
  actorUserId,
  ownerUserId: owner,
  holderUserId: holder,
  activeMemberUserIds: new Set([creator, owner, member, holder]),
  tripArchived: false,
  financeVersion: 4,
  fundStatus: 'OPEN',
});
const state: ExpenseState = {
  id: '10000000-0000-4000-8000-000000000004',
  createdByUserId: creator,
  status: 'DRAFT',
  version: 2,
  title: 'Taxi',
  description: null,
  amount: 100000n,
  category: null,
  receiptObjectKey: null,
  paidAt: null,
  paymentMethod: null,
};
const action = { expectedVersion: 2, expectedFinanceVersion: 4 };
const code = (work: () => unknown, expected: ExpenseRuleError['code']) => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(ExpenseRuleError);
    expect((error as ExpenseRuleError).code).toBe(expected);
    return;
  }
  throw new Error('Expected expense rule error');
};

describe('expense management rules', () => {
  it('allows any active member to create a draft in an OPEN Fund', () => {
    expect(() =>
      assertCanCreateExpense(
        {
          title: 'Taxi',
          description: null,
          amount: 1n,
          category: null,
          receiptObjectKey: null,
          paidAt: null,
          paymentMethod: null,
          expectedFinanceVersion: 4,
        },
        context(member),
      ),
    ).not.toThrow();
  });

  it('allows creator or Owner to edit/submit/delete a DRAFT', () => {
    for (const actor of [creator, owner]) {
      expect(
        planExpenseMutation(
          'UPDATE_EXPENSE',
          { ...action, title: 'Xe sân bay' },
          state,
          context(actor),
        ),
      ).toEqual({ changed: true, status: 'DRAFT' });
      expect(planExpenseMutation('SUBMIT_EXPENSE', action, state, context(actor)).status).toBe(
        'SUBMITTED',
      );
    }
    code(
      () => planExpenseMutation('DELETE_EXPENSE', action, state, context(member)),
      'PERMISSION_DENIED',
    );
  });

  it('only lets the creator withdraw a submitted proposal', () => {
    const submitted = { ...state, status: 'SUBMITTED' as const };
    expect(planExpenseMutation('WITHDRAW_EXPENSE', action, submitted, context(creator))).toEqual({
      changed: true,
      status: 'DRAFT',
    });
    code(
      () => planExpenseMutation('WITHDRAW_EXPENSE', action, submitted, context(owner)),
      'PERMISSION_DENIED',
    );
  });

  it('detects no-op patches and enforces state and optimistic versions', () => {
    expect(
      planExpenseMutation(
        'UPDATE_EXPENSE',
        { ...action, title: 'Taxi', description: null },
        state,
        context(creator),
      ).changed,
    ).toBe(false);
    code(
      () =>
        planExpenseMutation(
          'SUBMIT_EXPENSE',
          action,
          { ...state, status: 'REJECTED' },
          context(owner),
        ),
      'STATE_CONFLICT',
    );
    code(
      () =>
        planExpenseMutation(
          'UPDATE_EXPENSE',
          { ...action, expectedVersion: 3 },
          state,
          context(creator),
        ),
      'VERSION_CONFLICT',
    );
  });

  it('allows only the current Holder to confirm or reject a submitted expense', () => {
    const submitted = { ...state, status: 'SUBMITTED' as const };
    expect(
      planExpenseSettlement(
        'CONFIRM_EXPENSE',
        { ...action, paidAt: new Date('2026-10-22T03:15:30Z'), paymentMethod: 'CASH' },
        submitted,
        context(holder),
      ),
    ).toEqual({ status: 'CONFIRMED' });
    expect(
      planExpenseSettlement(
        'REJECT_EXPENSE',
        { ...action, reason: 'Duplicate' },
        submitted,
        context(holder),
      ),
    ).toEqual({ status: 'REJECTED' });
    code(
      () =>
        planExpenseSettlement(
          'CONFIRM_EXPENSE',
          { ...action, paidAt: new Date(), paymentMethod: 'CASH' },
          submitted,
          context(owner),
        ),
      'PERMISSION_DENIED',
    );
  });

  it('allows the Holder to reverse only a confirmed expense', () => {
    expect(
      planExpenseSettlement(
        'REVERSE_EXPENSE',
        { ...action, reason: 'Payment returned' },
        { ...state, status: 'CONFIRMED' },
        context(holder),
      ),
    ).toEqual({ status: 'REVERSED' });
    code(
      () =>
        planExpenseSettlement(
          'REVERSE_EXPENSE',
          { ...action, reason: 'Payment returned' },
          { ...state, status: 'SUBMITTED' },
          context(holder),
        ),
      'STATE_CONFLICT',
    );
    code(
      () =>
        planExpenseSettlement(
          'REJECT_EXPENSE',
          { ...action, expectedFinanceVersion: 3, reason: 'Duplicate' },
          { ...state, status: 'SUBMITTED' },
          context(holder),
        ),
      'VERSION_CONFLICT',
    );
  });
});
