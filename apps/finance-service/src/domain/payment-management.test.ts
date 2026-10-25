import { describe, expect, it } from 'vitest';
import {
  assertCanCreatePaymentAttempt,
  assertHolderPaymentAction,
  classifyMomoResult,
  PaymentRuleError,
} from './payment-management';

const member = 'member';
const holder = 'holder';
const context = {
  actorUserId: member,
  memberUserId: member,
  holderUserId: holder,
  activeMemberUserIds: new Set([member, holder]),
  fundStatus: 'OPEN' as const,
  requestStatus: 'OPEN',
  contributionStatus: 'PENDING',
  contributionVersion: 2,
  financeVersion: 3,
};
describe('Payment domain rules', () => {
  it('allows only Self on current open versions to create an attempt', () => {
    expect(() =>
      assertCanCreatePaymentAttempt({ expectedVersion: 2, expectedFinanceVersion: 3 }, context),
    ).not.toThrow();
    expect(() =>
      assertCanCreatePaymentAttempt({ expectedVersion: 1, expectedFinanceVersion: 3 }, context),
    ).toThrow(new PaymentRuleError('VERSION_CONFLICT'));
    expect(() =>
      assertCanCreatePaymentAttempt(
        { expectedVersion: 2, expectedFinanceVersion: 3 },
        { ...context, actorUserId: holder },
      ),
    ).toThrow(new PaymentRuleError('PERMISSION_DENIED'));
  });
  it('keeps Holder actions on an OPEN Fund and maps uncertain provider results to pending', () => {
    expect(() =>
      assertHolderPaymentAction(holder, holder, context.activeMemberUserIds, 'OPEN'),
    ).not.toThrow();
    expect(() =>
      assertHolderPaymentAction(holder, holder, context.activeMemberUserIds, 'CLOSING'),
    ).toThrow(new PaymentRuleError('STATE_CONFLICT'));
    expect(classifyMomoResult(0)).toBe('SUCCEEDED');
    expect(classifyMomoResult(9000)).toBe('PENDING');
    expect(classifyMomoResult(1000)).toBe('PENDING');
    expect(classifyMomoResult(49)).toBe('FAILED');
  });
});
