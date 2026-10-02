export type ContributionAction =
  'VIEW_PAYMENT_INSTRUCTION' | 'REPORT_TRANSFER' | 'CONFIRM_RECEIVED' | 'REJECT_TRANSFER';

/** Trusted, current context for the contribution's Fund and Trip, not client input. */
export type ContributionPermissionContext = Readonly<{
  actorUserId: string;
  memberUserId: string;
  holderUserId: string;
  activeMemberUserIds: ReadonlySet<string>;
}>;

export class ContributionPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContributionPermissionDeniedError';
  }
}

/**
 * Actor permissions for API086-089 / FR-FN03, without changing contribution state.
 * IDs must be validated, normalized UUIDs. Resolve actor identity from authentication,
 * memberUserId from the stored contribution, holderUserId from its Fund, and membership
 * from the current Trip context. Owner/Editor/Admin roles grant no override here.
 * The caller must also check lifecycle, source state, versions and idempotency;
 * Finance writes require the Trip guard. Passing this check does not confirm receipt.
 */
export function assertContributionActionAllowed(
  action: ContributionAction,
  context: ContributionPermissionContext,
): void {
  if (!context.activeMemberUserIds.has(context.actorUserId)) {
    throw new ContributionPermissionDeniedError('The actor must be an active member of the Trip');
  }

  switch (action) {
    case 'VIEW_PAYMENT_INSTRUCTION':
    case 'REPORT_TRANSFER':
      if (context.actorUserId !== context.memberUserId) {
        throw new ContributionPermissionDeniedError(
          'Only the contribution member can perform this action',
        );
      }
      return;
    case 'CONFIRM_RECEIVED':
    case 'REJECT_TRANSFER':
      if (context.actorUserId !== context.holderUserId) {
        throw new ContributionPermissionDeniedError(
          'Only the Fund Holder can review a transfer report',
        );
      }
      return;
    default:
      throw new TypeError('Unknown contribution action');
  }
}
