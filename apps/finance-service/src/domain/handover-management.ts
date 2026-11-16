import { FinanceReadError } from '../finance.errors';
import type { FundSetupContext } from './fund-setup';
import type { HandoverCreate, HandoverAction } from '../inputs/handover.input';

export const handoverScopes = [
  'CREATE_HOLDER_HANDOVER',
  'ACCEPT_HOLDER_HANDOVER',
  'REFRESH_HOLDER_HANDOVER',
  'CONFIRM_HOLDER_HANDOVER',
  'CANCEL_HOLDER_HANDOVER',
] as const;
export type HandoverScope = (typeof handoverScopes)[number];
export type HandoverState = {
  status: string;
  version: number;
  oldHolderUserId: string;
  newHolderUserId: string;
  snapshotFinanceVersion: number | null;
  oldConfirmed: boolean;
  newConfirmed: boolean;
};
export type HandoverContext = FundSetupContext & {
  holderUserId: string;
  fundStatus: string;
  financeVersion: number;
  closureLockId?: string;
};
function deny(code: 'PERMISSION_DENIED' | 'STATE_CONFLICT' | 'VERSION_CONFLICT'): never {
  throw new FinanceReadError(code);
}
function base(expected: number, context: HandoverContext) {
  if (!context.activeMemberUserIds.has(context.actorUserId)) deny('PERMISSION_DENIED');
  if (expected !== context.financeVersion) deny('VERSION_CONFLICT');
  if (
    context.fundStatus !== 'OPEN' ||
    context.tripArchived ||
    context.closureLockId ||
    context.financeVersion === 2147483647
  )
    deny('STATE_CONFLICT');
}
export function assertCreateHandover(body: HandoverCreate, context: HandoverContext) {
  base(body.expectedFinanceVersion, context);
  if (context.actorUserId !== context.ownerUserId) deny('PERMISSION_DENIED');
  if (
    body.newHolderUserId === context.holderUserId ||
    !context.activeMemberUserIds.has(body.newHolderUserId) ||
    !context.activeMemberUserIds.has(context.holderUserId)
  )
    deny('STATE_CONFLICT');
}
export function planHandoverAction(
  scope: Exclude<HandoverScope, 'CREATE_HOLDER_HANDOVER'>,
  body: HandoverAction,
  state: HandoverState,
  context: HandoverContext,
): { complete: boolean } {
  base(body.expectedFinanceVersion, context);
  if (body.expectedVersion !== state.version) deny('VERSION_CONFLICT');
  if (
    state.version === 2147483647 ||
    !['NOMINATED', 'ACCEPTED'].includes(state.status) ||
    state.oldHolderUserId !== context.holderUserId
  )
    deny('STATE_CONFLICT');
  const owner = context.actorUserId === context.ownerUserId,
    old = context.actorUserId === state.oldHolderUserId,
    next = context.actorUserId === state.newHolderUserId;
  if (scope === 'CANCEL_HOLDER_HANDOVER') {
    if (!owner && !old && !next) deny('PERMISSION_DENIED');
    return { complete: false };
  }
  if (
    !context.activeMemberUserIds.has(state.oldHolderUserId) ||
    !context.activeMemberUserIds.has(state.newHolderUserId)
  )
    deny('STATE_CONFLICT');
  if (scope === 'ACCEPT_HOLDER_HANDOVER') {
    if (!next) deny('PERMISSION_DENIED');
    if (state.status !== 'NOMINATED') deny('STATE_CONFLICT');
  } else if (scope === 'REFRESH_HOLDER_HANDOVER') {
    if (!owner && !old && !next) deny('PERMISSION_DENIED');
    if (state.status !== 'ACCEPTED') deny('STATE_CONFLICT');
  } else {
    if (!old && !next) deny('PERMISSION_DENIED');
    if (state.status !== 'ACCEPTED') deny('STATE_CONFLICT');
    if (
      state.snapshotFinanceVersion !== context.financeVersion ||
      body.expectedSnapshotFinanceVersion !== state.snapshotFinanceVersion
    )
      deny('VERSION_CONFLICT');
    if ((old && state.oldConfirmed) || (next && state.newConfirmed)) deny('STATE_CONFLICT');
    return { complete: (old && state.newConfirmed) || (next && state.oldConfirmed) };
  }
  return { complete: false };
}
