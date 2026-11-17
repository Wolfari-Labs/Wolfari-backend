import type { FinanceConflictReason } from '../finance.errors';
import type {
  ContributionManagementCommand,
  ContributionManagementScope,
} from '../inputs/contribution-management.input';

export class ContributionManagementError extends Error {
  constructor(
    readonly code: 'PERMISSION_DENIED' | 'STATE_CONFLICT' | 'VERSION_CONFLICT',
    readonly reason?: FinanceConflictReason,
  ) {
    super(code);
  }
}
export type ManagementState = {
  owner: boolean;
  fundOpen: boolean;
  requestOpen: boolean;
  version: number;
  financeVersion: number;
  title: string;
  note: string | null;
  dueAt: Date | null;
  amount?: string;
  pending?: boolean;
  memberActive?: boolean;
  blockedPayment: boolean;
  allPending: boolean;
};
/** Payment facts come from locked rows, never from client-supplied flags. */
export function planContributionManagement(
  scope: ContributionManagementScope,
  body: ContributionManagementCommand,
  state: ManagementState,
) {
  const fail = (
    code: ContributionManagementError['code'],
    reason?: FinanceConflictReason,
  ): never => {
    throw new ContributionManagementError(code, reason);
  };
  if (!state.owner) fail('PERMISSION_DENIED');
  if (!state.fundOpen) fail('STATE_CONFLICT', 'FUND_NOT_OPEN');
  if (!state.requestOpen) fail('STATE_CONFLICT', 'INVALID_TRANSITION');
  if (
    body.expectedVersion !== state.version ||
    body.expectedFinanceVersion !== state.financeVersion
  )
    fail('VERSION_CONFLICT');
  let changed: boolean;
  if (scope === 'UPDATE_CONTRIBUTION_REQUEST') {
    const dateChanged = body.dueAt !== undefined && body.dueAt.getTime() !== state.dueAt?.getTime();
    if (dateChanged && (!state.allPending || state.blockedPayment)) fail('STATE_CONFLICT');
    changed =
      dateChanged ||
      (body.title !== undefined && body.title !== state.title) ||
      (body.note !== undefined && body.note !== state.note);
  } else {
    if (!state.pending) fail('STATE_CONFLICT', 'INVALID_TRANSITION');
    if (!state.memberActive) fail('STATE_CONFLICT', 'MEMBER_NOT_ACTIVE');
    if (state.blockedPayment) fail('STATE_CONFLICT');
    changed = scope !== 'UPDATE_CONTRIBUTION_AMOUNT' || body.amount!.toString() !== state.amount;
  }
  if (changed && (state.version === 2147483647 || state.financeVersion === 2147483647))
    fail('STATE_CONFLICT');
  return {
    changed,
    version: state.version + Number(changed),
    financeVersion: state.financeVersion + Number(changed),
  };
}
