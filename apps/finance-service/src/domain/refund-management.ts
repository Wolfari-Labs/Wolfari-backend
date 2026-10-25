import type { FundSetupContext } from './fund-setup';
import type {
  RefundAction,
  RefundCreate,
  RefundReasonAction,
  RefundStatus,
} from '../inputs/refund.input';

export type RefundScope =
  | 'CREATE_REFUND'
  | 'REPORT_REFUND_PAID'
  | 'CONFIRM_REFUND_RECEIVED'
  | 'CONFIRM_REFUND_NONRECEIPT'
  | 'CANCEL_REFUND'
  | 'REQUEST_REFUND_REVERSAL'
  | 'CONSENT_REFUND_REVERSAL'
  | 'REVERSE_REFUND';
export type RefundState = {
  memberUserId: string;
  status: RefundStatus;
  version: number;
  nonreceiptConfirmedAt: Date | null;
  reversalRequestedAt: Date | null;
  reversalConsentedAt: Date | null;
  reversalReason: string | null;
};
type Context = FundSetupContext & {
  holderUserId: string;
  fundStatus: string;
  financeVersion: number;
};
export class RefundRuleError extends Error {
  constructor(public readonly code: 'PERMISSION_DENIED' | 'STATE_CONFLICT' | 'VERSION_CONFLICT') {
    super(code);
  }
}
function base(expectedFinanceVersion: number, context: Context) {
  if (expectedFinanceVersion !== context.financeVersion)
    throw new RefundRuleError('VERSION_CONFLICT');
  if (context.fundStatus !== 'OPEN' || context.financeVersion === 2147483647)
    throw new RefundRuleError('STATE_CONFLICT');
  if (!context.activeMemberUserIds.has(context.actorUserId))
    throw new RefundRuleError('PERMISSION_DENIED');
}
export function assertCanCreateRefund(body: RefundCreate, context: Context) {
  base(body.expectedFinanceVersion, context);
  if (context.actorUserId !== context.ownerUserId) throw new RefundRuleError('PERMISSION_DENIED');
  if (!context.activeMemberUserIds.has(body.memberUserId))
    throw new RefundRuleError('STATE_CONFLICT');
}
export function planRefundAction(
  scope: Exclude<RefundScope, 'CREATE_REFUND'>,
  body: RefundAction | RefundReasonAction,
  state: RefundState,
  context: Context,
) {
  base(body.expectedFinanceVersion, context);
  if (body.expectedVersion !== state.version) throw new RefundRuleError('VERSION_CONFLICT');
  if (state.version === 2147483647) throw new RefundRuleError('STATE_CONFLICT');
  const holder = context.actorUserId === context.holderUserId;
  const owner = context.actorUserId === context.ownerUserId;
  const recipient = context.actorUserId === state.memberUserId;
  switch (scope) {
    case 'REPORT_REFUND_PAID':
      if (!holder) throw new RefundRuleError('PERMISSION_DENIED');
      if (state.status !== 'PENDING') throw new RefundRuleError('STATE_CONFLICT');
      return;
    case 'CONFIRM_REFUND_RECEIVED':
      if (!recipient) throw new RefundRuleError('PERMISSION_DENIED');
      if (state.status !== 'HOLDER_REPORTED') throw new RefundRuleError('STATE_CONFLICT');
      return;
    case 'CONFIRM_REFUND_NONRECEIPT':
      if (!recipient) throw new RefundRuleError('PERMISSION_DENIED');
      if (state.status !== 'HOLDER_REPORTED' || state.nonreceiptConfirmedAt)
        throw new RefundRuleError('STATE_CONFLICT');
      return;
    case 'CANCEL_REFUND':
      if (!owner) throw new RefundRuleError('PERMISSION_DENIED');
      if (
        state.status !== 'PENDING' &&
        !(state.status === 'HOLDER_REPORTED' && state.nonreceiptConfirmedAt)
      )
        throw new RefundRuleError('STATE_CONFLICT');
      return;
    case 'REQUEST_REFUND_REVERSAL':
      if (!holder) throw new RefundRuleError('PERMISSION_DENIED');
      if (state.status !== 'CONFIRMED' || state.reversalRequestedAt)
        throw new RefundRuleError('STATE_CONFLICT');
      return;
    case 'CONSENT_REFUND_REVERSAL':
      if (!recipient) throw new RefundRuleError('PERMISSION_DENIED');
      if (state.status !== 'CONFIRMED' || !state.reversalRequestedAt || state.reversalConsentedAt)
        throw new RefundRuleError('STATE_CONFLICT');
      return;
    case 'REVERSE_REFUND': {
      if (!holder) throw new RefundRuleError('PERMISSION_DENIED');
      const reason = (body as RefundReasonAction).reason;
      if (
        state.status !== 'CONFIRMED' ||
        !state.reversalRequestedAt ||
        !state.reversalConsentedAt ||
        reason !== state.reversalReason
      )
        throw new RefundRuleError('STATE_CONFLICT');
    }
  }
}
