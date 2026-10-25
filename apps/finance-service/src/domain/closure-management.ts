import type { FundSetupContext } from './fund-setup';

export type ClosureAuthority = FundSetupContext & {
  holderUserId: string;
  fundStatus: string;
  financeVersion: number;
  closureStatus?: string;
  closureUserIds?: ReadonlySet<string>;
};

export class ClosureRuleError extends Error {
  constructor(public readonly code: 'PERMISSION_DENIED' | 'STATE_CONFLICT' | 'VERSION_CONFLICT') {
    super(code);
  }
}
export function assertCreateClosure(expectedFinanceVersion: number, authority: ClosureAuthority) {
  if (authority.actorUserId !== authority.ownerUserId)
    throw new ClosureRuleError('PERMISSION_DENIED');
  if (
    authority.tripArchived ||
    authority.fundStatus !== 'OPEN' ||
    !authority.activeMemberUserIds.has(authority.holderUserId)
  )
    throw new ClosureRuleError('STATE_CONFLICT');
  if (authority.financeVersion !== expectedFinanceVersion)
    throw new ClosureRuleError('VERSION_CONFLICT');
}
export function assertClosureAction(
  scope: 'CONFIRM_CLOSURE' | 'CANCEL_CLOSURE' | 'REMIND_CLOSURE',
  authority: ClosureAuthority,
) {
  if (
    authority.tripArchived ||
    authority.fundStatus !== 'CLOSING' ||
    authority.closureStatus !== 'PENDING_CONFIRMATIONS'
  )
    throw new ClosureRuleError('STATE_CONFLICT');
  if (scope === 'CONFIRM_CLOSURE') {
    if (!authority.closureUserIds?.has(authority.actorUserId))
      throw new ClosureRuleError('PERMISSION_DENIED');
  } else if (authority.actorUserId !== authority.ownerUserId) {
    throw new ClosureRuleError('PERMISSION_DENIED');
  }
}
