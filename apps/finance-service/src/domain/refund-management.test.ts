import { describe, expect, it } from 'vitest';
import {
  assertCanCreateRefund,
  planRefundAction,
  RefundRuleError,
  type RefundState,
} from './refund-management';

const owner = '10000000-0000-4000-8000-000000000001',
  holder = '10000000-0000-4000-8000-000000000002',
  recipient = '10000000-0000-4000-8000-000000000003',
  member = '10000000-0000-4000-8000-000000000004';
const context = (actor: string) => ({
  actorUserId: actor,
  ownerUserId: owner,
  holderUserId: holder,
  activeMemberUserIds: new Set([owner, holder, recipient, member]),
  tripArchived: false,
  fundStatus: 'OPEN',
  financeVersion: 4,
});
const state: RefundState = {
  memberUserId: recipient,
  status: 'PENDING',
  version: 2,
  nonreceiptConfirmedAt: null,
  reversalRequestedAt: null,
  reversalConsentedAt: null,
  reversalReason: null,
};
const action = { expectedVersion: 2, expectedFinanceVersion: 4 };
const denied = (work: () => unknown, code: RefundRuleError['code']) => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(RefundRuleError);
    expect((error as RefundRuleError).code).toBe(code);
    return;
  }
  throw new Error('Expected refund rule error');
};
describe('refund rules', () => {
  it('lets only Owner reserve a refund for an active member', () => {
    expect(() =>
      assertCanCreateRefund(
        { memberUserId: recipient, amount: 1n, reason: 'Dư', expectedFinanceVersion: 4 },
        context(owner),
      ),
    ).not.toThrow();
    denied(
      () =>
        assertCanCreateRefund(
          { memberUserId: recipient, amount: 1n, reason: 'Dư', expectedFinanceVersion: 4 },
          context(holder),
        ),
      'PERMISSION_DENIED',
    );
  });
  it('requires Holder report then recipient confirmation', () => {
    expect(() =>
      planRefundAction('REPORT_REFUND_PAID', action, state, context(holder)),
    ).not.toThrow();
    const reported = { ...state, status: 'HOLDER_REPORTED' as const };
    expect(() =>
      planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, context(recipient)),
    ).not.toThrow();
    denied(
      () => planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, context(owner)),
      'PERMISSION_DENIED',
    );
  });
  it('allows cancel after recipient nonreceipt, never after confirmation', () => {
    const reported = {
      ...state,
      status: 'HOLDER_REPORTED' as const,
      nonreceiptConfirmedAt: new Date(),
    };
    expect(() =>
      planRefundAction(
        'CANCEL_REFUND',
        { ...action, reason: 'Không nhận' },
        reported,
        context(owner),
      ),
    ).not.toThrow();
    denied(
      () =>
        planRefundAction(
          'CANCEL_REFUND',
          { ...action, reason: 'x' },
          { ...state, status: 'CONFIRMED' },
          context(owner),
        ),
      'STATE_CONFLICT',
    );
  });
  it('binds reversal consent to the stored reason and role sequence', () => {
    const confirmed = { ...state, status: 'CONFIRMED' as const };
    expect(() =>
      planRefundAction(
        'REQUEST_REFUND_REVERSAL',
        { ...action, reason: 'Trả nhầm' },
        confirmed,
        context(holder),
      ),
    ).not.toThrow();
    const requested = { ...confirmed, reversalRequestedAt: new Date(), reversalReason: 'Trả nhầm' };
    expect(() =>
      planRefundAction('CONSENT_REFUND_REVERSAL', action, requested, context(recipient)),
    ).not.toThrow();
    const consented = { ...requested, reversalConsentedAt: new Date() };
    expect(() =>
      planRefundAction(
        'REVERSE_REFUND',
        { ...action, reason: 'Trả nhầm' },
        consented,
        context(holder),
      ),
    ).not.toThrow();
    denied(
      () =>
        planRefundAction(
          'REVERSE_REFUND',
          { ...action, reason: 'Lý do khác' },
          consented,
          context(holder),
        ),
      'STATE_CONFLICT',
    );
  });
  it('rejects stale entity and Finance versions', () => {
    denied(
      () =>
        planRefundAction(
          'REPORT_REFUND_PAID',
          { expectedVersion: 1, expectedFinanceVersion: 4 },
          state,
          context(holder),
        ),
      'VERSION_CONFLICT',
    );
    denied(
      () =>
        planRefundAction(
          'REPORT_REFUND_PAID',
          { expectedVersion: 2, expectedFinanceVersion: 3 },
          state,
          context(holder),
        ),
      'VERSION_CONFLICT',
    );
  });
});
