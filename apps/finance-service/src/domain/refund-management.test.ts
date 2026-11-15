import { describe, expect, it } from 'vitest';
import {
  assertCanCreateRefund,
  planRefundAction,
  refundConfirmer,
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
  it('requires the current Owner to verify a refund to a different Holder', () => {
    const reported = { ...state, memberUserId: holder, status: 'HOLDER_REPORTED' as const };
    expect(refundConfirmer(reported, context(owner))).toEqual({
      userId: owner,
      mode: 'OWNER',
      independent: true,
    });
    expect(() =>
      planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, context(owner)),
    ).not.toThrow();
    denied(
      () => planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, context(holder)),
      'PERMISSION_DENIED',
    );
    denied(
      () => planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, context(member)),
      'PERMISSION_DENIED',
    );
  });
  it('requires an assigned active independent Member when Owner is Holder', () => {
    const reported = { ...state, memberUserId: holder, status: 'HOLDER_REPORTED' as const };
    const selfHolder = { ...context(holder), ownerUserId: holder };
    denied(
      () => planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, selfHolder),
      'STATE_CONFLICT',
    );
    expect(() =>
      planRefundAction(
        'ASSIGN_REFUND_VERIFIER',
        { ...action, verifierUserId: member },
        reported,
        selfHolder,
      ),
    ).not.toThrow();
    for (const verifierUserId of [holder, 'not-a-member'])
      denied(
        () =>
          planRefundAction(
            'ASSIGN_REFUND_VERIFIER',
            { ...action, verifierUserId },
            reported,
            selfHolder,
          ),
        'STATE_CONFLICT',
      );
    denied(
      () =>
        planRefundAction(
          'ASSIGN_REFUND_VERIFIER',
          { ...action, verifierUserId: recipient },
          reported,
          { ...selfHolder, actorUserId: member },
        ),
      'PERMISSION_DENIED',
    );
    const assigned = {
      ...reported,
      verifierUserId: member,
      verifierAssignedByUserId: holder,
      verifierHolderUserId: holder,
    };
    expect(refundConfirmer(assigned, selfHolder)).toEqual({
      userId: member,
      mode: 'ASSIGNED_MEMBER',
      independent: true,
    });
    expect(() =>
      planRefundAction('CONFIRM_REFUND_RECEIVED', action, assigned, {
        ...selfHolder,
        actorUserId: member,
      }),
    ).not.toThrow();
    denied(
      () => planRefundAction('CONFIRM_REFUND_RECEIVED', action, assigned, selfHolder),
      'PERMISSION_DENIED',
    );
    denied(
      () =>
        planRefundAction(
          'ASSIGN_REFUND_VERIFIER',
          { ...action, verifierUserId: member },
          assigned,
          selfHolder,
        ),
      'STATE_CONFLICT',
    );
    denied(
      () =>
        planRefundAction('CONFIRM_REFUND_RECEIVED', action, assigned, {
          ...selfHolder,
          actorUserId: member,
          activeMemberUserIds: new Set([holder, recipient]),
        }),
      'PERMISSION_DENIED',
    );
    denied(
      () => refundConfirmer({ ...assigned, verifierAssignedByUserId: owner }, selfHolder),
      'STATE_CONFLICT',
    );
    denied(
      () => refundConfirmer({ ...assigned, verifierHolderUserId: owner }, selfHolder),
      'STATE_CONFLICT',
    );
    // Ownership change replaces the previously assigned verifier immediately.
    expect(refundConfirmer(assigned, context(owner)).userId).toBe(owner);
  });
  it('decides independence against who reported paying, not the Holder after a handover', () => {
    // Owner H was Holder, reported paying a refund to themself, then handed the Fund to M.
    const reported = {
      ...state,
      memberUserId: holder,
      status: 'HOLDER_REPORTED' as const,
      holderReportedByUserId: holder,
    };
    const afterHandover = { ...context(holder), ownerUserId: holder, holderUserId: member };
    denied(() => refundConfirmer(reported, afterHandover), 'STATE_CONFLICT');
    denied(
      () => planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, afterHandover),
      'STATE_CONFLICT',
    );
    // An unrelated member is denied before any state check.
    denied(
      () =>
        planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, {
          ...afterHandover,
          actorUserId: recipient,
        }),
      'PERMISSION_DENIED',
    );
    // A verifier assigned while H paid stays valid; M did not pay, so M may verify as Holder.
    const assigned = {
      ...reported,
      verifierUserId: member,
      verifierAssignedByUserId: holder,
      verifierHolderUserId: holder,
    };
    expect(refundConfirmer(assigned, afterHandover)).toEqual({
      userId: member,
      mode: 'ASSIGNED_MEMBER',
      independent: true,
    });
    expect(() =>
      planRefundAction(
        'ASSIGN_REFUND_VERIFIER',
        { ...action, verifierUserId: recipient },
        reported,
        afterHandover,
      ),
    ).not.toThrow();
    // H reported paying M's refund before M became Holder: M confirms as recipient, H cannot.
    const paidToMember = { ...reported, memberUserId: member };
    expect(refundConfirmer(paidToMember, afterHandover)).toEqual({
      userId: member,
      mode: 'RECIPIENT',
      independent: true,
    });
    denied(
      () => planRefundAction('CONFIRM_REFUND_RECEIVED', action, paidToMember, afterHandover),
      'PERMISSION_DENIED',
    );
    // Rows without a stored reporter (reported before V004 on a Fund that never changed Holder)
    // fall back to the current-Holder rule; V004 backfills the reporter for those rows.
    expect(refundConfirmer({ ...reported, holderReportedByUserId: null }, afterHandover)).toEqual({
      userId: holder,
      mode: 'RECIPIENT',
      independent: true,
    });
  });
  it('marks single-member self confirmation as not independently verified', () => {
    const reported = { ...state, memberUserId: holder, status: 'HOLDER_REPORTED' as const };
    const single = {
      ...context(holder),
      ownerUserId: holder,
      activeMemberUserIds: new Set([holder]),
    };
    expect(refundConfirmer(reported, single)).toEqual({
      userId: holder,
      mode: 'SELF_UNVERIFIED',
      independent: false,
    });
    expect(() =>
      planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, single),
    ).not.toThrow();
    denied(
      () =>
        planRefundAction('CONFIRM_REFUND_RECEIVED', action, reported, {
          ...single,
          activeMemberUserIds: new Set([holder, member]),
        }),
      'STATE_CONFLICT',
    );
  });
  it('keeps nonreceipt and reversal consent with the recipient, not the verifier', () => {
    const reported = { ...state, memberUserId: holder, status: 'HOLDER_REPORTED' as const };
    denied(
      () => planRefundAction('CONFIRM_REFUND_NONRECEIPT', action, reported, context(owner)),
      'PERMISSION_DENIED',
    );
    const requested = {
      ...reported,
      status: 'CONFIRMED' as const,
      reversalRequestedAt: new Date(),
      reversalReason: 'wrong',
    };
    denied(
      () => planRefundAction('CONSENT_REFUND_REVERSAL', action, requested, context(owner)),
      'PERMISSION_DENIED',
    );
    expect(() =>
      planRefundAction('CONSENT_REFUND_REVERSAL', action, requested, context(holder)),
    ).not.toThrow();
  });
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
