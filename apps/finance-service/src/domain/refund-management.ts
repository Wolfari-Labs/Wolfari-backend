import type { FundSetupContext } from './fund-setup';
import type {
  RefundAction,
  RefundCreate,
  RefundReasonAction,
  RefundStatus,
  RefundVerifierAction,
} from '../inputs/refund.input';

export type RefundScope =
  | 'CREATE_REFUND'
  | 'ASSIGN_REFUND_VERIFIER'
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
  verifierUserId?: string | null;
  verifierAssignedByUserId?: string | null;
  verifierHolderUserId?: string | null;
  /** Member who reported paying this refund; null while PENDING or for rows reported before V004. */
  holderReportedByUserId?: string | null;
};
export type RefundContext = FundSetupContext & {
  holderUserId: string;
  fundStatus: string;
  financeVersion: number;
};
export class RefundRuleError extends Error {
  constructor(public readonly code: 'PERMISSION_DENIED' | 'STATE_CONFLICT' | 'VERSION_CONFLICT') {
    super(code);
  }
}
function base(expectedFinanceVersion: number, context: RefundContext) {
  if (expectedFinanceVersion !== context.financeVersion)
    throw new RefundRuleError('VERSION_CONFLICT');
  if (context.fundStatus !== 'OPEN' || context.financeVersion === 2147483647)
    throw new RefundRuleError('STATE_CONFLICT');
  if (!context.activeMemberUserIds.has(context.actorUserId))
    throw new RefundRuleError('PERMISSION_DENIED');
}
export function assertCanCreateRefund(body: RefundCreate, context: RefundContext) {
  base(body.expectedFinanceVersion, context);
  if (context.actorUserId !== context.ownerUserId) throw new RefundRuleError('PERMISSION_DENIED');
  if (!context.activeMemberUserIds.has(body.memberUserId))
    throw new RefundRuleError('STATE_CONFLICT');
}
export type RefundConfirmationMode = 'RECIPIENT' | 'OWNER' | 'ASSIGNED_MEMBER' | 'SELF_UNVERIFIED';
/**
 * The member who pays or paid this refund. Once reported, the reporter stays the payer even if the
 * Fund Holder changes later (handover), so the payer can never become their own verifier.
 */
export function refundPayerUserId(state: RefundState, context: RefundContext) {
  return state.status === 'HOLDER_REPORTED' && state.holderReportedByUserId
    ? state.holderReportedByUserId
    : context.holderUserId;
}
export function refundConfirmer(
  state: RefundState,
  context: RefundContext,
): {
  userId: string;
  mode: RefundConfirmationMode;
  independent: boolean;
} {
  if (!context.activeMemberUserIds.has(state.memberUserId))
    throw new RefundRuleError('STATE_CONFLICT');
  const payer = refundPayerUserId(state, context);
  if (state.memberUserId !== payer)
    return { userId: state.memberUserId, mode: 'RECIPIENT', independent: true };
  if (context.ownerUserId !== payer) {
    if (!context.activeMemberUserIds.has(context.ownerUserId))
      throw new RefundRuleError('STATE_CONFLICT');
    return { userId: context.ownerUserId, mode: 'OWNER', independent: true };
  }
  if (context.activeMemberUserIds.size === 1)
    return { userId: payer, mode: 'SELF_UNVERIFIED', independent: false };
  if (
    !state.verifierUserId ||
    state.verifierUserId === payer ||
    !context.activeMemberUserIds.has(state.verifierUserId) ||
    state.verifierAssignedByUserId !== context.ownerUserId ||
    state.verifierHolderUserId !== payer
  )
    throw new RefundRuleError('STATE_CONFLICT');
  return { userId: state.verifierUserId, mode: 'ASSIGNED_MEMBER', independent: true };
}
export function planRefundAction(
  scope: Exclude<RefundScope, 'CREATE_REFUND'>,
  body: RefundAction | RefundReasonAction | RefundVerifierAction,
  state: RefundState,
  context: RefundContext,
) {
  base(body.expectedFinanceVersion, context);
  if (body.expectedVersion !== state.version) throw new RefundRuleError('VERSION_CONFLICT');
  if (state.version === 2147483647) throw new RefundRuleError('STATE_CONFLICT');
  const holder = context.actorUserId === context.holderUserId;
  const owner = context.actorUserId === context.ownerUserId;
  const recipient = context.actorUserId === state.memberUserId;
  switch (scope) {
    case 'ASSIGN_REFUND_VERIFIER': {
      if (!owner) throw new RefundRuleError('PERMISSION_DENIED');
      const verifier = (body as RefundVerifierAction).verifierUserId;
      const payer = refundPayerUserId(state, context);
      if (
        !['PENDING', 'HOLDER_REPORTED'].includes(state.status) ||
        state.memberUserId !== payer ||
        context.ownerUserId !== payer ||
        verifier === payer ||
        !context.activeMemberUserIds.has(verifier) ||
        (verifier === state.verifierUserId &&
          state.verifierAssignedByUserId === context.ownerUserId &&
          state.verifierHolderUserId === payer)
      )
        throw new RefundRuleError('STATE_CONFLICT');
      return;
    }
    case 'REPORT_REFUND_PAID':
      if (!holder) throw new RefundRuleError('PERMISSION_DENIED');
      if (state.status !== 'PENDING') throw new RefundRuleError('STATE_CONFLICT');
      return;
    case 'CONFIRM_REFUND_RECEIVED':
      // Only the recipient, the Owner or the assigned verifier can ever confirm; anyone else is
      // denied before state is inspected, so unrelated members see 403 rather than 409.
      if (
        ![state.memberUserId, context.ownerUserId, state.verifierUserId].includes(
          context.actorUserId,
        )
      )
        throw new RefundRuleError('PERMISSION_DENIED');
      if (state.status !== 'HOLDER_REPORTED') throw new RefundRuleError('STATE_CONFLICT');
      if (context.actorUserId !== refundConfirmer(state, context).userId)
        throw new RefundRuleError('PERMISSION_DENIED');
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
